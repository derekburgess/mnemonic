import { runtimeSandboxConfig, resourceArgs } from "../src/sandboxConfig.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { event, type EmitEvent } from "./events.js";

const exec = promisify(execFile);
const root = path.resolve("local-model");
const owner = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12);
const label = `mnemonic.local-model=${owner}`;
const live = new Set<string>();
const docker = async (args: string[], signal?: AbortSignal) =>
  (await exec("docker", args, { signal, timeout: signal ? 0 : 30_000, maxBuffer: 1024 * 1024 })).stdout;

export async function removeModelContainer(name: string) {
  try { await docker(["rm", "--force", name]); live.delete(name); }
  catch (err) {
    // Absence is success; a daemon failure must not be reported as memory released.
    const names = await docker(["ps", "-aq", "--filter", `name=^/${name}$`]);
    if (names.trim()) throw new Error(`Could not remove local model container ${name}: ${(err as Error).message}`);
    live.delete(name);
  }
}

export async function sweepLocalModels() {
  const names = (await docker(["ps", "-aq", "--filter", `label=${label}`])).trim().split("\n").filter(Boolean);
  for (const name of names) await removeModelContainer(name);
  return names.length;
}

// Use the same shutdown lifecycle as node containers, plus a scoped startup sweep after crashes.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    for (const name of live) spawn("docker", ["rm", "--force", name], { detached: true, stdio: "ignore" }).unref();
  });
}

export async function prepareModelContainer(signal: AbortSignal, emit: EmitEvent, phase: (name: string) => void, downloading = false, useGpu = false, sandboxConfig?: string) {
  const config = runtimeSandboxConfig(downloading ? undefined : sandboxConfig).localModel;
  await docker(["info", "--format", "{{json .Runtimes}}"], signal)
    .catch(() => { throw new Error("Local models require a running Docker daemon. Start Docker and retry."); });
  signal.throwIfAborted();
  await sweepLocalModels();
  // Downloading only populates the cache; GPU access is an explicit inference setting.
  const gpu = !downloading && useGpu;
  const hash = createHash("sha256").update(gpu ? "cuda" : "cpu");
  for (const file of ["Dockerfile", "requirements.txt", "worker.py"]) hash.update(readFileSync(path.join(root, file)));
  const image = `mnemonic-local-model:${hash.digest("hex").slice(0, 12)}`;
  try { await docker(["image", "inspect", image], signal); }
  catch {
    signal.throwIfAborted();
    phase("Building runtime");
    emit(event("proxy", "local.image_build_started", { image, device: gpu ? "cuda" : "cpu" }));
    await new Promise<void>((resolve, reject) => {
      const build = spawn("docker", ["build", "-t", image, "--build-arg",
        `TORCH_INDEX=https://download.pytorch.org/whl/${gpu ? "cu124" : "cpu"}`, root], { signal, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const log = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); };
      build.stdout.on("data", log); build.stderr.on("data", log);
      build.once("error", reject);
      build.once("close", (code) => {
        emit(event("proxy", "local.image_build_finished", { image, code, log: output }));
        if (code === 0) resolve(); else reject(new Error(`Local model runtime image build failed (exit ${code}). See the build log in the trace.`));
      });
    });
  }
  signal.throwIfAborted();
  phase("Starting container");
  const cache = path.resolve("data/models");
  mkdirSync(cache, { recursive: true });
  const name = `mnemonic-model-${owner}-${randomUUID().slice(0, 8)}`;
  live.add(name);
  try {
    await docker(["create", "--interactive", "--init", "--name", name, "--label", label,
      "--cap-drop=ALL", "--security-opt=no-new-privileges", ...resourceArgs(config), "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=256m",
      "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--mount", `type=bind,source=${cache},target=/models${downloading ? "" : ",readonly"}`,
      ...(downloading ? [] : ["--network=none"]), ...(gpu ? ["--gpus", "all"] : []), image], signal);
  } catch (err) { await removeModelContainer(name); throw err; }
  emit(event("proxy", "local.container_created", { name, image, device: gpu ? "cuda" : "cpu" }));
  return { name, command: "docker", args: ["start", "--attach", "--interactive", name], cache: "/models" };
}

export async function inspectModelContainer(name: string) {
  return JSON.parse(await docker(["inspect", "--format", "{{json .State}}", name])) as { OOMKilled?: boolean; ExitCode?: number; Error?: string };
}
