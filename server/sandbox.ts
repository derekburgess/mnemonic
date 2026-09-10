import { event, type EmitEvent, type TraceEvent } from "./events.js";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { TIMEOUT_MESSAGE } from "./providers.js";
import type { Job, JobResult } from "./runner.js";
import { workspaceNames } from "./workspace.js";
import { containerLogger, type ContainerTrace } from "./containerTrace.js";

/**
 * Runs one step inside an ephemeral container.
 *
 * The container is created when the step starts and destroyed when it returns. `--rm` alone is
 * not enough for that: it fires when the container *exits*, and killing the `docker run` client
 * leaves the container running quite happily on its own. So teardown removes it by name, from
 * every path — normal return, timeout, proxy shutdown — with a sweep at startup for whatever a
 * previous life of this process left behind.
 *
 * The proxy keeps the graph, the trace and the HTTP surface; the container gets a job on stdin
 * and answers on stdout.
 *
 * What this does and does not buy: custom tool code stops running in the proxy's own process,
 * and workspace access becomes a kernel-enforced mount rather than a path check. The step still
 * reaches the network, and the API key still travels in, because a contained step that cannot
 * call the model is not a step. So this is isolation from the *host*, not from the internet.
 */

const run = promisify(execFile);
const ROOT = path.resolve(process.cwd());

/** Where a workspace is mounted inside the container. */
const MOUNT_BASE = "/workspaces";

/** Bounds a runaway step. The step's own timeout still applies inside. */
const LIMITS = [
  "--memory=2g",
  "--pids-limit=512",
  "--cpus=2",
  // Nothing in here needs to gain privileges, and dropping capabilities costs the runner nothing.
  "--security-opt=no-new-privileges",
  "--cap-drop=ALL",
];

/** How long the image build may take before we give up on it. */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

export type Mount = { host: string; container: string; name: string };

/**
 * Where each workspace lands inside the container. Named the same as it would be uncontained,
 * so a prompt written for one runs unchanged in the other — and the model is told
 * `/workspaces/notes` rather than the shape of your home directory.
 */
export function mountsFor(roots: string[]): Mount[] {
  return workspaceNames(roots).map(({ name, dir }) => ({
    host: dir,
    container: path.posix.join(MOUNT_BASE, name),
    name,
  }));
}

/* -------------------------------------------------------------------------- */
/* The image                                                                   */
/* -------------------------------------------------------------------------- */

/** Everything baked into the image; a change to any of it is a different image. */
const IMAGE_INPUTS = [
  "sandbox/Dockerfile",
  "sandbox/package.json",
  "server/providers.ts",
  "server/tools.ts",
  "server/links.ts",
  "server/workspace.ts",
  "server/runner.ts",
  "server/events.ts",
];

let imageTag: string | null = null;

/**
 * Tagged by the hash of what goes into it, so editing a provider or a tool rebuilds rather than
 * silently running yesterday's code — the failure that would otherwise be hardest to see.
 */
function tagFor(): string {
  if (imageTag) return imageTag;
  const hash = createHash("sha256");
  for (const file of IMAGE_INPUTS) hash.update(readFileSync(path.join(ROOT, file)));
  imageTag = `mnemonic-sandbox:${hash.digest("hex").slice(0, 12)}`;
  return imageTag;
}

/** One build at a time, however many steps ask for it at once. */
let building: Promise<string> | null = null;

async function ensureImage(emit?: EmitEvent): Promise<string> {
  const tag = tagFor();
  try {
    await run("docker", ["image", "inspect", tag], { timeout: 10_000 });
    emit?.(event("proxy", "image.cached", { image: tag }));
    return tag;
  } catch {
    /* not built yet */
  }

  emit?.(event("proxy", building ? "image.waiting" : "image.build_started", { image: tag }));
  const waitingSince = Date.now();
  building ??= (async () => {
    console.log(`[mnemonic] building sandbox image ${tag} (first contained run only)…`);
    const started = Date.now();
    try {
      await run("docker", ["build", "-t", tag, "-f", "sandbox/Dockerfile", "."], {
        cwd: ROOT,
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      });
      console.log(`[mnemonic] sandbox image ready in ${Math.round((Date.now() - started) / 1000)}s`);
      return tag;
    } finally {
      building = null;
    }
  })();

  const ready = await building;
  emit?.(event("proxy", "image.build_ready", { image: ready, ms: Date.now() - waitingSince }));
  return ready;
}

/* -------------------------------------------------------------------------- */
/* Availability                                                                */
/* -------------------------------------------------------------------------- */

export type SandboxStatus = { available: boolean; runtime?: string; version?: string; reason?: string };

/**
 * Whether a step could be contained right now. The UI asks so the toggle can disable itself
 * rather than offering a guarantee this machine cannot keep.
 */
export async function sandboxStatus(): Promise<SandboxStatus> {
  try {
    const { stdout } = await run("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 10_000,
    });
    return { available: true, runtime: "docker", version: stdout.trim() };
  } catch (err) {
    const message = (err as Error).message;
    return {
      available: false,
      reason: /not found|ENOENT/i.test(message)
        ? "Docker is not installed on the machine running the proxy."
        : "Docker is installed but its daemon is not reachable from the proxy.",
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Running a step                                                              */
/* -------------------------------------------------------------------------- */

export type SandboxRun = { result: JobResult; stderr: string };

/** Marks every container we start, so orphans can be found later without guessing at names. */
const LABEL = "mnemonic.sandbox=step";

/** Containers believed to be running right now, so shutdown can take them with it. */
const live = new Set<string>();

/**
 * `--rm` only fires when the container *exits*, and killing the `docker run` client does not
 * stop the container — it keeps running, detached, forever. So every teardown path removes the
 * container by name rather than trusting the flag.
 */
async function destroy(name: string): Promise<boolean> {
  live.delete(name);
  try {
    await run("docker", ["rm", "--force", "--volumes", name], { timeout: 30_000 });
    return true;
  } catch {
    return false; // Missing container or failed removal; retain uncertainty in the trace.
  }
}

/**
 * Anything left by a previous life of this process — a crash, a `tsx watch` restart mid-run —
 * is removed at startup. Cheap, and the alternative is a container quietly holding a mount and
 * an API key until someone notices.
 */
export async function sweepOrphans(): Promise<number> {
  try {
    const { stdout } = await run("docker", ["ps", "-aq", "--filter", `label=${LABEL}`], {
      timeout: 15_000,
    });
    const ids = stdout.trim().split("\n").filter(Boolean);
    if (!ids.length) return 0;
    await run("docker", ["rm", "--force", "--volumes", ...ids], { timeout: 60_000 });
    return ids.length;
  } catch {
    return 0; // no docker, or nothing to do
  }
}

// A proxy going down should not leave containers holding mounts. Best-effort and synchronous
// enough to land before exit; the startup sweep is what catches whatever does not.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    for (const name of live) {
      try {
        spawn("docker", ["rm", "--force", "--volumes", name], { detached: true, stdio: "ignore" }).unref();
      } catch {
        /* going down anyway */
      }
    }
    process.kill(process.pid, signal === "SIGINT" ? "SIGINT" : "SIGTERM");
  });
}

/**
 * Sends one job through a container and returns what it answered.
 *
 * A step that asked to be contained and cannot be is an error, never a quiet fallback to running
 * on the host: silently dropping an isolation guarantee is worse than not offering one.
 */
export async function runInSandbox(
  job: Job,
  mounts: Mount[],
  opts: { timeoutSec: number; readOnly?: boolean; onTrace?: (trace: ContainerTrace) => void; onEvent?: EmitEvent; signal?: AbortSignal } = { timeoutSec: 300 },
): Promise<SandboxRun> {
  const log = containerLogger([job.apiKey, ...(job.tools ?? []).flatMap((t) => t.kind === "mcp" && t.authorization ? [t.authorization, t.authorization.replace(/^Bearer\s+/i, "")] : [])], opts.onEvent);
  let containerName: string | undefined;
  try {
    opts.signal?.throwIfAborted();
    log.event("Checking Docker availability");
    const status = await sandboxStatus();
    if (!status.available) {
      throw Object.assign(new Error(`This step is set to run in a container. ${status.reason}`), {
        status: 503,
      });
    }

    log.event("Preparing sandbox image (building if needed)");
    const tag = await ensureImage(opts.onEvent);
    opts.signal?.throwIfAborted();
    log.trace.image = tag;
    log.event("Sandbox image ready");
    // Named so it can be removed by name from any teardown path, including one where the client
    // that started it is already dead.
    const name = `mnemonic-step-${randomUUID().slice(0, 12)}`;
    containerName = name;
    log.trace.name = name;

    const args = [
      "run",
      "--interactive",
      "--name",
      name,
      "--label",
      LABEL,
      ...LIMITS,
      // The step talks to the model over the network, so egress stays on. host-gateway is what
      // makes an MCP server on the host's localhost reachable from in here.
      "--add-host=host.docker.internal:host-gateway",
      ...mounts.flatMap((m) => ["-v", `${m.host}:${m.container}${opts.readOnly ? ":ro" : ""}`]),
      tag,
    ];

    live.add(name);
    log.event("Starting container");
    opts.onEvent?.(event("proxy", "container.starting", { name, image: tag, limits: LIMITS }));
    return await new Promise<SandboxRun>((resolve, reject) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });

      let stdout = "";
      let timedOut = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d) => (stdout += d));
      let pending = "";
      let liveLogs = "";
      let loggedChars = 0;
      const flushLogs = () => {
        if (liveLogs && loggedChars < 65_536) {
          const text = liveLogs.slice(0, Math.min(8000, 65_536 - loggedChars));
          loggedChars += text.length;
          opts.onEvent?.(event("container", "container.log", { text, truncated: loggedChars >= 65_536 }));
        }
        liveLogs = "";
      };
      const logTimer = setInterval(flushLogs, 1000);
      const line = (text: string) => {
        if (text.startsWith("\x1e")) {
          try {
            const entry = JSON.parse(text.slice(1)) as TraceEvent;
            if (typeof entry.id === "string" && Number.isFinite(entry.at) &&
                /^(runner|tool|model|round)\./.test(entry.kind)) {
              opts.onEvent?.({ ...entry, source: "container" });
              if (entry.kind === "runner.resources") {
                const memory = (entry.detail as { peakMemoryBytes?: number })?.peakMemoryBytes;
                if (typeof memory === "number") log.trace.peakMemoryBytes = memory;
              }
              return;
            }
          } catch { /* Preserve malformed events as ordinary logs. */ }
        }
        log.stderr(text + "\n");
        liveLogs = (liveLogs + text + "\n").slice(-8000);
      };
      child.stderr.on("data", (d: string) => {
        pending += d;
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          line(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
        if (pending.length > 65_536) { line(pending.slice(0, 65_536)); pending = pending.slice(-65_536); }
      });

      // Killing the client does not stop the container, so the container is removed directly
      // and the client is left to notice its stdout closed.
      const terminate = (reason: string) => {
        timedOut = reason === "deadline exceeded";
        log.event(`${reason}; forcing container termination`);
        log.trace.termination = `${reason}; forced termination`;
        void run("docker", ["kill", name], { timeout: 10_000 }).catch(() => {}).finally(() => child.kill("SIGKILL"));
      };
      const cancel = () => terminate("cancelled");
      const timer = setTimeout(() => terminate("deadline exceeded"), Math.max(30, opts.timeoutSec + 30) * 1000);
      opts.signal?.addEventListener("abort", cancel, { once: true });
      if (opts.signal?.aborted) cancel();

      child.on("error", (err) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", cancel);
        clearInterval(logTimer);
        flushLogs();
        reject(err);
      });

      child.stdin.on("error", (err) => {
        log.event(`Could not deliver job: ${err.message}`);
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", cancel);
        clearInterval(logTimer);
        if (pending) line(pending);
        flushLogs();
        log.trace.termination ??= code === 0 ? "normal exit" : "process failure";
        log.trace.exitCode = code;
        log.trace.signal = signal;
        log.event(`Container process closed (exit ${code}, signal ${signal ?? "none"})`);
        const stderr = log.snapshot().stderr;
        if (opts.signal?.aborted) return reject(new Error("cancelled"));
        if (timedOut) {
          return reject(
            Object.assign(new Error(TIMEOUT_MESSAGE), { status: 504 }),
          );
        }
        if (!stdout.trim()) {
          return reject(
            new Error(
              `The container exited (${code}) without returning a result. ${stderr.trim().slice(-600)}`,
            ),
          );
        }
        try {
          const result = JSON.parse(stdout) as JobResult;
          log.event(result.ok ? "Runner returned a successful result" : "Runner returned an error");
          resolve({ result, stderr });
        } catch {
          reject(new Error("The container returned an unreadable result; see container diagnostics in Trace Logs."));
        }
      });

      child.stdin.end(JSON.stringify(job));
    });
  } catch (err) {
    const e = err as Error & { stderr?: string };
    if (e.stderr) log.stderr(e.stderr);
    log.event(`Container run failed: ${e.message}`);
    throw err;
  } finally {
    // Belt and braces: `--rm` has usually done this already, and a no-op removal is cheap next
    // to a container left holding a mount.
    if (containerName) {
      // Keep the stopped container until inspection; --rm would erase OOM and exit evidence.
      try {
        const { stdout } = await run("docker", ["inspect", "--format", "{{json .State}}", containerName], { timeout: 10_000 });
        const state = JSON.parse(stdout) as { OOMKilled?: boolean; ExitCode?: number };
        log.trace.dockerState = state;
        log.trace.oomKilled = state.OOMKilled;
        if (state.OOMKilled) log.trace.termination = "out of memory";
        opts.onEvent?.(event("proxy", "container.exited", { state, termination: log.trace.termination, peakMemoryBytes: log.trace.peakMemoryBytes }));
      } catch {
        opts.onEvent?.(event("proxy", "container.inspect_unavailable", { termination: log.trace.termination }));
      }
      const removed = await destroy(containerName);
      opts.onEvent?.(event("proxy", "container.cleanup", { removed, forced: log.trace.termination?.includes("forced") ?? false }));
      log.event("Container cleanup attempted");
    }
    opts.onTrace?.(log.snapshot());
  }
}
