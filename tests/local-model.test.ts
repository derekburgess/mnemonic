import { test } from "node:test";
import assert from "node:assert/strict";
import { withLocalModel, acquireModel, localCompletion, localActivity } from "../server/localModels.ts";
import type { TraceEvent } from "../server/events.ts";
import path from "node:path";

const worker = { python: "python3", script: path.resolve("tests/fixtures/local-worker.py"), model: "test" };

test("local workers serve requests and exit before the next model acquires memory", async () => {
  const events: TraceEvent[] = [];
  let token = "";
  const result = await withLocalModel({ ...worker, signal: new AbortController().signal, emit: (e) => events.push(e) }, async (credentials) => {
    token = credentials.apiKey;
    await assert.rejects(localCompletion(token, { model: "other" }), /does not match/);
    return localCompletion(token, { model: "test" });
  }, 8787);
  assert.deepEqual(result, { text: "ok" });
  assert.ok(events.find((e) => e.kind === "local.unloaded"));
  assert.ok(events.findIndex((e) => e.kind === "local.worker_exited") < events.findIndex((e) => e.kind === "local.unloaded"));
  await assert.rejects(localCompletion(token, { model: "test" }), /ended/);
  assert.equal(localActivity(), null);
});

test("load and generation errors preserve actionable memory failures and unload", async () => {
  for (const model of ["load-error", "inference-error"]) {
    const events: TraceEvent[] = [];
    await assert.rejects(withLocalModel({ ...worker, model, signal: new AbortController().signal, emit: (e) => events.push(e) },
      ({ apiKey }) => localCompletion(apiKey, { model }), 8787), /memory|RAM/);
    assert.ok(events.some((e) => e.kind === "local.unloaded"));
  }
});

test("cancelling a loading worker releases the queue and process", async () => {
  const controller = new AbortController();
  const events: TraceEvent[] = [];
  const run = withLocalModel({ ...worker, model: "hang", signal: controller.signal, emit: (e) => events.push(e) }, async () => {}, 8787);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(run, /cancelled/);
  assert.ok(events.some((e) => e.kind === "local.unloaded"));
  const release = await acquireModel(new AbortController().signal);
  release();
});

test("queued cancellations never admit a second model early", async () => {
  const first = await acquireModel(new AbortController().signal);
  const controller = new AbortController();
  const second = acquireModel(controller.signal);
  controller.abort();
  await assert.rejects(second);
  let admitted = false;
  const third = acquireModel(new AbortController().signal).then((release) => { admitted = true; return release; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(admitted, false);
  first();
  (await third)();
});

test("a missing Python environment gives an actionable error and releases the queue", async () => {
  await assert.rejects(withLocalModel({ ...worker, python: "/nonexistent/mnemonic-python", signal: new AbortController().signal, emit: () => {} }, async () => {}, 8787), /setup:local-model/);
  const release = await acquireModel(new AbortController().signal);
  release();
});
