import assert from "node:assert/strict";
import { test } from "node:test";
import { applyExecutionProgress, initialExecutionStates, summarizeExecution, statusDuration, type ExecutionProgress } from "../src/executionStatus.ts";

const execution = { runId: "run", execIds: ["a"], startedMs: 1000, timeoutSec: 900 };
const entry = (kind: string, detail: unknown = {}, execId = "a", order = 1): ExecutionProgress["events"][number] =>
  ({ id: String(order), kind, detail, execId, order, at: order * 1000, source: "proxy" });
const batch = (events: ExecutionProgress["events"], steps: ExecutionProgress["steps"] = []): ExecutionProgress =>
  ({ cursor: events.length, events, steps });

test("node status follows trace phases and ignores HTTP chatter and unrelated executions", () => {
  let states = initialExecutionStates(execution);
  states = applyExecutionProgress(states, batch([entry("local.loading")]));
  assert.equal(summarizeExecution(states).message, "Loading model");
  states = applyExecutionProgress(states, batch([entry("model.started", { round: 2 })]));
  states = applyExecutionProgress(states, batch([entry("local.running"), entry("model.http_attempt"),
    entry("delivery.poll"), entry("local.loading", {}, "another-node")]));
  assert.equal(summarizeExecution(states).message, "Generating response · round 2");
  states = applyExecutionProgress(states, batch([entry("tool.started", { name: "read_file" })]));
  assert.equal(summarizeExecution(states).message, "Running tool: read_file");
  states = applyExecutionProgress(states, batch([entry("runner.completed")]));
  assert.equal(summarizeExecution(states).message, "Cleaning up containers");
  assert.equal(summarizeExecution(states).active, true, "a finished model has not finished cleanup");
  states = applyExecutionProgress(states, batch([], [{ execId: "a", status: "ok", error: null, finishedMs: 5000 }]));
  states = applyExecutionProgress(states, batch([entry("local.unloading")]));
  assert.equal(summarizeExecution(states).message, "Completed");
  assert.equal(summarizeExecution(states).finishedMs, 5000);
});

test("queued or completed outputs do not hide another output's active generation", () => {
  let states = initialExecutionStates({ ...execution, execIds: ["a", "b"] });
  states = applyExecutionProgress(states, batch([entry("model.started", { round: 1 }, "a"), entry("local.queued", {}, "b", 2)]));
  assert.equal(summarizeExecution(states).message, "Generating response · round 1 · 0/2 finished");
  states = applyExecutionProgress(states, batch([entry("model.started", { round: 1 }, "b")],
    [{ execId: "a", status: "error", error: "model failed", finishedMs: 2000 }]));
  assert.equal(summarizeExecution(states).message, "Generating response · round 1 · 1/2 finished");
  assert.equal(summarizeExecution(states).active, true);
  states = applyExecutionProgress(states, batch([], [{ execId: "b", status: "ok", error: null, finishedMs: 4000 }]));
  assert.equal(summarizeExecution(states).message, "Failed: model failed · 2/2 finished");
  assert.equal(summarizeExecution(states).finishedMs, 4000);
});

test("cancellation and timeout remain distinct and cleanup precedes terminal status", () => {
  for (const error of ["cancelled", "The step hit its timeout."]) {
    let states = applyExecutionProgress(initialExecutionStates(execution), batch([entry("runner.failed", { error })]));
    assert.equal(summarizeExecution(states).message, error === "cancelled" ? "Stopping — cancelled" : "Stopping — timeout reached");
    states = applyExecutionProgress(states, batch([entry("local.unloading")]));
    assert.equal(summarizeExecution(states).message, "Cleaning up containers");
    states = applyExecutionProgress(states, batch([], [{ execId: "a", status: "error", error, finishedMs: 9000 }]));
    assert.equal(summarizeExecution(states).message, error === "cancelled" ? "Cancelled" : "Failed: timeout reached");
  }
});

test("timing uses the actual run budget rather than subsequent node edits", () => {
  const states = applyExecutionProgress(initialExecutionStates(execution), batch([
    entry("execution.budget", { deadlineMs: 901000, timeoutSec: 900 }),
  ]));
  const summary = summarizeExecution(states);
  assert.equal(summary.startedMs, 1000);
  assert.equal(summary.timeoutSec, 900);
  assert.equal(statusDuration(252000), "4m 12s");
  assert.equal(statusDuration(900000), "15m");
  assert.equal(statusDuration(-1000), "0s");
});
