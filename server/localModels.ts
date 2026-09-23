import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { event, redactText, type EmitEvent } from "./events.js";

export type LocalActivity = { phase: string; model: string; nodeId?: string; downloaded?: number; total?: number; message?: string; queued: number };
let activity: LocalActivity | null = null;
export const localActivity = () => activity ? { ...activity, queued: queue.length } : queue.length ? { phase: "Queued", model: "", queued: queue.length } : null;
let occupied = false;
const queue: Array<() => void> = [];
export async function acquireModel(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const enter = () => { signal.removeEventListener("abort", abort); occupied = true; resolve(); };
    const abort = () => { const i = queue.indexOf(enter); if (i >= 0) queue.splice(i, 1); reject(signal.reason); };
    if (!occupied) enter();
    else { queue.push(enter); signal.addEventListener("abort", abort, { once: true }); }
  });
  let released = false;
  return () => { if (released) return; released = true; occupied = false; queue.shift()?.(); };
}

type Reply = { id?: number; result?: unknown; error?: string; phase?: string; downloaded?: number; total?: number; message?: string; resources?: unknown };
const sessions = new Map<string, { request: (body: unknown) => Promise<unknown>; model: string }>();
export async function localCompletion(token: string, body: { model?: string }): Promise<unknown> {
  const session = sessions.get(token);
  if (!session) throw new Error("Local model session has ended or is not authorized.");
  if (body.model !== session.model) throw new Error("The requested model does not match this node's local worker.");
  return session.request(body);
}

export async function withLocalModel<T>(options: {
  model: string; nodeId?: string; token?: string; signal: AbortSignal; emit: EmitEvent;
  python?: string; script?: string;
}, run: (credentials: { apiKey: string; baseUrl: string }) => Promise<T>, port: number): Promise<T> {
  options.emit(event("proxy", "local.queued", { model: options.model }));
  const release = await acquireModel(options.signal);
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed: Promise<void> | undefined;
  let key: string | undefined;
  let failure: Error | undefined;
  const update = (detail: Reply) => {
    activity = { phase: detail.phase ?? "Preparing", model: options.model, nodeId: options.nodeId,
      downloaded: detail.downloaded, total: detail.total, message: detail.message, queued: queue.length };
    options.emit(event("proxy", `local.${activity.phase.toLowerCase()}`, { ...activity, resources: detail.resources }));
  };
  try {
    options.signal.throwIfAborted();
    update({ phase: "Preparing" });
    const venvPython = path.resolve("data/local-model-venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const python = options.python ?? process.env.MNEMONIC_PYTHON ?? (existsSync(venvPython) ? venvPython : "python3");
    mkdirSync(path.resolve("data/models"), { recursive: true });
    child = spawn(python, ["-u", options.script ?? path.resolve("local-model/worker.py")], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HF_HUB_DISABLE_TELEMETRY: "1", TOKENIZERS_PARALLELISM: "false" },
    });
    const worker = child;
    let exited = false;
    closed = new Promise<void>((resolve) => worker.once("close", () => { exited = true; resolve(); }));
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let die!: (e: Error) => void;
    const dead = new Promise<never>((_, reject) => { die = reject; });
    void dead.catch(() => {});
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (e: Error) => void }>();
    let serial = 0;
    const fail = (error: Error) => {
      failure ??= error; readyReject(error); die(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    const abort = () => { fail(new Error(options.signal.reason?.name === "TimeoutError" ? "Local model run timed out. Increase the node timeout for downloads and loading." : "cancelled")); worker.kill("SIGKILL"); };
    options.signal.addEventListener("abort", abort, { once: true });
    void closed.then(() => options.signal.removeEventListener("abort", abort));
    worker.on("error", () => fail(new Error("Could not start the local Python worker. Run npm run setup:local-model, or set MNEMONIC_PYTHON to an environment with the local model dependencies.")));
    worker.stdin.on("error", (err) => fail(new Error(`Local model worker input failed: ${err.message}`)));
    let stderr = "";
    worker.stderr.on("data", (data: Buffer) => { stderr = (stderr + redactText(data.toString(), [options.token ?? ""])).slice(-6000); });
    worker.once("close", (code, signal) => {
      if (stderr) options.emit(event("proxy", "local.logs", { text: stderr }));
      options.emit(event("proxy", "local.worker_exited", { code, signal }));
      fail(failure ?? new Error(`Model worker exited unexpectedly (code ${code}, signal ${signal ?? "none"}). Memory exhaustion is possible but not confirmed. See the local worker trace.`));
    });
    const lines = createInterface({ input: worker.stdout });
    lines.on("line", (line) => {
      try {
        const reply = JSON.parse(line) as Reply;
        if (reply.error) {
          const error = new Error(redactText(reply.error, [options.token ?? ""]));
          if (reply.id !== undefined) { failure = error; pending.get(reply.id)?.reject(error); pending.delete(reply.id); }
          else fail(error);
        } else if (reply.id !== undefined) { pending.get(reply.id)?.resolve(reply.result); pending.delete(reply.id); }
        else if (reply.phase) { update(reply); if (reply.phase === "Ready") readyResolve(); }
      } catch { /* Third-party stdout is not part of the worker protocol. */ }
    });
    worker.stdin.write(JSON.stringify({ model: options.model, token: options.token || null, cache: path.resolve("data/models") }) + "\n");
    if (options.signal.aborted) abort();
    await ready;
    key = crypto.randomUUID();
    let requesting = false;
    sessions.set(key, { model: options.model, request: async (body) => {
      if (requesting) throw new Error("The local worker is already generating a response.");
      if (failure || exited) throw failure ?? new Error("Local worker is unavailable.");
      requesting = true;
      update({ phase: "Running" });
      try {
        return await new Promise((resolve, reject) => {
          const id = ++serial;
          pending.set(id, { resolve, reject });
          worker.stdin.write(JSON.stringify({ id, body }) + "\n");
        });
      } finally { requesting = false; }
    } });
    return await Promise.race([run({ apiKey: key, baseUrl: `http://127.0.0.1:${port}/api/local-inference` }), dead]);
  } catch (err) {
    update({ phase: "Error", message: (err as Error).message });
    throw err;
  } finally {
    if (key) sessions.delete(key);
    if (child) {
      update({ phase: "Unloading" });
      child.kill("SIGKILL");
      await closed;
      options.emit(event("proxy", "local.unloaded", { model: options.model, memoryReleased: true }));
    }
    activity = null;
    release();
  }
}
