import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { event } from "../server/events.ts";

test("async admission is idempotent and result delivery is independent of the request", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemonic-integration-"));
  let release!: () => void;
  let modelCalls = 0;
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  const model = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain request */ }
    modelCalls++; modelStarted();
    await new Promise<void>((resolve) => { release = resolve; });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "chat", model: "test", choices: [{ index: 0,
      message: { role: "assistant", content: "Recovered output" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2 } }));
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  t.after(() => { release?.(); model.closeAllConnections(); model.close(); });
  const address = model.address() as { port: number };
  await mkdir(path.join(dir, "data"));
  await writeFile(path.join(dir, "data/settings.json"), JSON.stringify({ provider: "compatible", apiKey: "test-secret",
    baseUrl: `http://127.0.0.1:${address.port}/v1` }));
  // Keep the integration test independent of the machine's Docker daemon and containers.
  await writeFile(path.join(dir, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
    fileURLToPath(new URL("../server/index.ts", import.meta.url))], { cwd: dir,
    env: { ...process.env, PORT: "0", PATH: `${dir}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    await rm(dir, { recursive: true, force: true });
  });
  const base = await new Promise<string>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/proxy listening on (http:\/\/localhost:\d+)/);
      if (match) resolve(match[1]);
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", (code) => reject(new Error(`proxy exited ${code}: ${output}`)));
  });
  const controller = new AbortController();
  const request = fetch(`${base}/api/run`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", input: "test", timeoutSec: 5,
      trace: { runId: "run", execId: "exec", nodeId: "step", clientSentMs: Date.now() } }), signal: controller.signal });
  const accepted = await request;
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).execId, "exec");
  await started;
  // Trace writes are queued asynchronously; receiving the HTTP model request does not mean
  // its model.started event has committed to the database yet.
  let live;
  for (let i = 0; i < 100; i++) {
    live = await (await fetch(`${base}/api/trace/runs/run/progress`)).json();
    if (live.events.some((e: { kind: string }) => e.kind === "model.started")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(live.steps[0].status, "running");
  assert.ok(live.events.some((e: { kind: string }) => e.kind === "model.started"));
  controller.abort();
  const duplicate = await fetch(`${base}/api/run`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", input: "test", trace: { runId: "run", execId: "exec" } }) });
  assert.equal(duplicate.status, 202);
  release();
  let result;
  for (let i = 0; i < 100; i++) {
    result = await (await fetch(`${base}/api/trace/result/run/exec`)).json();
    if (result.status === "ok") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(result.text, "Recovered output");
  assert.equal(modelCalls, 1);
  const events = [event("browser", "delivery.recovered"), event("browser", "graph.committed", { outputId: "output" })];
  for (let i = 0; i < 2; i++) {
    const ack = await fetch(`${base}/api/trace/events`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: "run", execId: "exec", events }) });
    assert.equal(ack.status, 200);
  }
  const { steps } = await (await fetch(`${base}/api/trace/runs/run`)).json();
  assert.equal(steps[0].status, "ok");
  assert.equal(steps[0].delivery, "added to graph");
  assert.equal(steps[0].events.filter((e: { kind: string }) => e.kind === "graph.committed").length, 1);
  assert.ok(steps[0].events.some((e: { kind: string }) => e.kind === "response.sent"));
  assert.ok(!JSON.stringify(steps).includes("test-secret"));

  // A short node budget cancels a hanging model and persists the timeout, even when the SDK
  // surfaces its own abort exception. It must not get lost by mutating DOMException.message.
  const timed = await fetch(`${base}/api/run`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test", input: "test", timeoutSec: 0.1,
      trace: { runId: "timeout", execId: "timeout", nodeId: "step" } }) });
  assert.equal(timed.status, 202);
  let expired;
  for (let i = 0; i < 100; i++) {
    expired = await (await fetch(`${base}/api/executions/timeout/timeout`)).json();
    if (expired.status === "error") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(expired.status, "error");
  assert.match(expired.error, /step hit its timeout/);
  assert.equal(modelCalls, 2, "one request per run, with no retry after the budget expires");
});
