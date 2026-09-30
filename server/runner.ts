import { readFileSync } from "node:fs";
import { event, sanitize, type TraceEvent } from "./events.js";
import net from "node:net";
import { Console } from "node:console";
import { ExecutionBudget, executionClient } from "./execution.js";
import { buildTools, type ToolSpec } from "./tools.js";
import { TIMEOUT_MESSAGE, runChat, runResponses, type RunFile } from "./providers.js";

// stdout is the result protocol. Tool console.log/info/debug must not corrupt it.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

/**
 * The whole of one step, executed inside a container.
 *
 * The proxy stays outside: it owns the graph, the trace database and the HTTP surface, none of
 * which belong in something ephemeral. What crosses the boundary is a job on stdin and a result
 * on stdout, so the container needs no port, no volume beyond the step's workspaces, and no way
 * to reach the host except the network calls the step itself makes.
 *
 * The credentials arrive on stdin rather than in the environment: `docker inspect` and
 * `/proc/self/environ` would both otherwise hand them to anything running in here, and custom
 * tool code runs in here too.
 */

export type Job = {
  apiKey: string;
  baseUrl?: string;
  provider: "openai" | "compatible" | "huggingface";
  model: string;
  effort?: string;
  input: string;
  instructions?: string;
  tools?: ToolSpec[];
  maxRounds?: number;
  timeoutSec?: number;
  deadlineMs?: number;
  managedLocal?: boolean;
  files?: RunFile[];
  links?: string[];
  /** Already rewritten to the paths they are mounted at in here. */
  workspaces?: string[];
  workspaceTools?: import("../src/toolSettings.js").WorkspaceToolSettings;
};

/** Rounds travel back with the result so the trace outside is as complete as an uncontained run. */
export type JobResult =
  | { ok: true; result: Awaited<ReturnType<typeof runResponses>>; rounds: unknown[] }
  | { ok: false; error: string; status?: number; rounds: unknown[] };

/* -------------------------------------------------------------------------- */
/* Reaching an MCP server on the host                                          */
/* -------------------------------------------------------------------------- */

/** Docker publishes the host to the container under this name. */
const HOST_ALIAS = "host.docker.internal";

/** Hostnames that mean "this machine" when written on the host. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]);

/**
 * An MCP server you started on your own machine is not in here, and the obvious fix — rewriting
 * its URL to host.docker.internal — breaks it a different way: FastMCP and friends check the
 * `Host` header against an allow-list and answer **421 Misdirected Request** to a name they do
 * not recognise. Overriding the header is not an option either, since fetch silently drops it.
 *
 * So the URL is left exactly as written and the *port* is brought into the container instead:
 * a listener on the container's own loopback, forwarding to the host. The SDK then connects to
 * `127.0.0.1:8765` for real, sends `Host: 127.0.0.1:8765`, and the server sees what it expects.
 */
function hostPortsUsedBy(tools: ToolSpec[]): number[] {
  const ports = new Set<number>();
  for (const tool of tools) {
    if (tool.enabled === false || tool.kind !== "mcp" || !tool.serverUrl) continue;
    try {
      const url = new URL(tool.serverUrl);
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      if (!LOOPBACK.has(hostname)) continue;
      ports.add(Number(url.port) || (url.protocol === "https:" ? 443 : 80));
    } catch {
      /* an unparseable URL fails later, with a better message than anything we could add */
    }
  }
  return [...ports];
}

/** Returns a teardown for every forwarder it managed to start. */
async function forwardHostPorts(ports: number[]): Promise<() => void> {
  const servers: net.Server[] = [];

  for (const port of ports) {
    const server = net.createServer((client) => {
      const upstream = net.connect(port, HOST_ALIAS);
      const stop = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", stop);
      upstream.on("error", stop);
      client.pipe(upstream);
      upstream.pipe(client);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve());
      });
      servers.push(server);
    } catch (err) {
      // Not fatal: the MCP connection will fail with its own message, which says more about
      // what went wrong than a failure to set up a forwarder would.
      console.error(`[sandbox] could not forward port ${port}: ${(err as Error).message}`);
    }
  }

  return () => servers.forEach((s) => s.close());
}

const readStdin = () =>
  new Promise<string>((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });

async function main() {
  const job = JSON.parse(await readStdin()) as Job;
  console.info("[sandbox] Job received; preparing tools");
  const rounds: unknown[] = [];
  const emit = (entry: TraceEvent) => process.stderr.write(`\x1e${JSON.stringify({ ...entry, detail: sanitize(entry.detail, [job.apiKey]) })}\n`);
  emit(event("container", "runner.accepted"));

  const budget = new ExecutionBudget(job.timeoutSec ?? 300, undefined, job.deadlineMs);
  let stopForwarding = () => {};
  try {
    budget.remainingMs();
    stopForwarding = await budget.wait(forwardHostPorts(hostPortsUsedBy(job.tools ?? [])));
    const client = executionClient(job, budget, job.managedLocal);

    const { tools, dispatch } = await budget.wait(buildTools(job.tools ?? [], job.workspaces ?? [], (e) => emit({ ...e, source: "container" }), budget, job.workspaceTools ?? {}));
    console.info(`[sandbox] Tools ready (${tools.length}); starting model run`);
    const run = job.provider !== "openai" ? runChat : runResponses;

    const result = await budget.wait(run({
      onEvent: emit,
      eventSource: "container",
      signal: budget.signal,
      client,
      transport: budget.fetch,
      model: job.model,
      effort: job.effort,
      input: job.input,
      instructions: job.instructions,
      tools,
      dispatch,
      maxRounds: job.maxRounds,
      files: job.files,
      links: job.links,
      onRound: (round) => {
        rounds.push(round);
        emit(event("container", "round.recorded", { round: rounds.length, ...round }));
        console.info(`[sandbox] Round ${rounds.length} completed`);
      },
    }));

    console.info("[sandbox] Run completed; returning result");
    emit(event("container", "runner.completed"));
    write({ ok: true, result, rounds });
  } catch (err) {
    const raw = err as { status?: number; message?: string; name?: string };
    const e = Object.assign(new Error(raw.message ?? "request failed", { cause: err }), { name: raw.name ?? "Error", status: raw.status });
    if (budget.signal.aborted || /abort|timeout/i.test(`${e.name} ${e.message}`)) {
      e.message = TIMEOUT_MESSAGE;
      e.status = 504;
    }
    emit(event("container", "runner.failed", { error: e.message, status: e.status }));
    write({ ok: false, error: e.message ?? "request failed", status: e.status, rounds });
  } finally {
    await budget.dispose();
    let peakMemoryBytes: number | undefined;
    for (const file of ["/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"]) {
      try { const value = Number(readFileSync(file, "utf8")); if (Number.isFinite(value)) { peakMemoryBytes = value; break; } } catch { /* unavailable */ }
    }
    emit(event("container", "runner.resources", { peakMemoryBytes, available: peakMemoryBytes !== undefined }));
    stopForwarding();
  }
}

/**
 * The result is the only thing on stdout. Anything a tool logged went to stderr, which the proxy
 * keeps for diagnostics rather than trying to parse.
 */
function write(payload: JobResult) {
  process.stdout.write(JSON.stringify(payload));
}

main().catch((err) => {
  write({ ok: false, error: (err as Error).message, rounds: [] });
  process.exitCode = 1;
});
