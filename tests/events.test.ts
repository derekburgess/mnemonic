import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { event, deliveryState, sanitize, tracedFetch, type TraceEvent } from "../server/events.ts";
import { runChat } from "../server/providers.ts";
import { buildTools } from "../server/tools.ts";

test("redaction and size limits preserve tool correlation metadata", () => {
  const value = sanitize({ name: "tool", round: 3, ms: 25, authorization: "private",
    output: "secret-key" + "x".repeat(100_000) }, ["secret-key"]) as Record<string, unknown>;
  assert.equal(value.name, "tool");
  assert.equal(value.round, 3);
  assert.equal(value.truncated, true);
  assert.ok(JSON.stringify(value).length <= 16_384);
  assert.ok(!JSON.stringify(value).includes("secret-key"));
  assert.ok(!JSON.stringify(value).includes("private"));
  assert.equal(typeof sanitize("x".repeat(100_000)), "string");
});

test("late delivery events cannot undo a graph acknowledgement", () => {
  const events = [event("browser", "delivery.recovered"), event("browser", "graph.committed"), event("browser", "delivery.recovering")];
  assert.equal(deliveryState(events), "added to graph");
  assert.equal(deliveryState([events[0]]), "recovered from trace");
});

test("model retry attempts and tool timing/error outcomes are traced", async (t) => {
  const events: TraceEvent[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) return Response.json({ error: { message: "retry" } }, { status: 429, headers: { "retry-after-ms": "1" } });
    return Response.json({ id: "chat", model: "test", choices: [{ index: 0, message: calls === 2
      ? { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "broken", arguments: "{}" } }] }
      : { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
  });
  const emit = (e: TraceEvent) => { events.push(e); };
  const client = new OpenAI({ apiKey: "test", baseURL: "http://unused/v1", fetch: tracedFetch(emit, "proxy") });
  const { tools, dispatch } = await buildTools([{ kind: "custom", fnName: "broken", fnCode: "throw new Error('tool failed')" }], [], emit);
  const result = await runChat({ client, model: "test", input: "test", tools, dispatch, onRound: () => {}, onEvent: emit });
  assert.equal(result.text, "done");
  assert.ok(events.some((e) => e.kind === "model.http_attempt" && (e.detail as { retry: number }).retry === 1));
  const end = events.find((e) => e.kind === "tool.completed")!;
  assert.equal((end.detail as { callId: string }).callId, "call-1");
  assert.equal((end.detail as { round: number }).round, 1);
  assert.equal((end.detail as { status: string }).status, "error");
  assert.ok(events.some((e) => e.kind === "tool.configured"));
});

test("a model timeout leaves a durable structured failure event", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new DOMException("timed out", "TimeoutError"); });
  const events: TraceEvent[] = [];
  const client = new OpenAI({ apiKey: "test", maxRetries: 0 });
  await assert.rejects(runChat({ client, model: "test", input: "test", tools: [], dispatch: async () => "",
    onRound: () => {}, onEvent: (e) => events.push(e) }));
  assert.ok(events.some((e) => e.kind === "model.failed"));
});
