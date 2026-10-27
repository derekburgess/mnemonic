import assert from "node:assert/strict";
import test from "node:test";
import { parseInferenceConfiguration, serializeInferenceConfiguration } from "../src/inferenceConfig.ts";
import type { InputData } from "../src/types.ts";

const configured: InputData = {
  label: "Review", provider: "openai", model: "gpt-5", effort: "high", outputs: 2,
  maxRounds: 8, timeoutSec: 300, loop: true, loopLimit: 4, loopOutputMode: "all",
  tools: [{ id: "search", label: "Search", kind: "web_search", enabled: true }],
  collapsed: true, status: "error", error: "old failure",
  lastExecution: { canvasId: "canvas", runId: "run", execIds: ["exec"], startedMs: 1, timeoutSec: 300 },
};

test("inference configuration JSON is portable and excludes transient node state", () => {
  const serialized = serializeInferenceConfiguration(configured);
  const value = JSON.parse(serialized);
  assert.equal(value.label, "Review");
  assert.equal(value.loopOutputMode, "all");
  assert.deepEqual(value.tools, configured.tools);
  assert.equal("collapsed" in value, false);
  assert.equal("status" in value, false);
  assert.equal("error" in value, false);
  assert.equal("lastExecution" in value, false);
});

test("inference configuration accepts a complete exported node and validates unsafe shapes", () => {
  assert.deepEqual(parseInferenceConfiguration(JSON.stringify({ id: "step", type: "step", data: configured })),
    JSON.parse(serializeInferenceConfiguration(configured)));
  assert.throws(() => parseInferenceConfiguration("[]"), /JSON object/);
  assert.throws(() => parseInferenceConfiguration('{"outputs": 9}'), /cannot exceed 8/);
  assert.throws(() => parseInferenceConfiguration('{"tools": {}}'), /must be an array/);
});
