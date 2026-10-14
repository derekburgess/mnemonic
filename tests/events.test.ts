import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import { event, deliveryState, sanitize, sanitizeJsonText, sanitizeTraceContext, tracedFetch, type TraceEvent } from "../server/events.ts";
import { runChat } from "../server/providers.ts";
import { buildTools } from "../server/tools.ts";

test("connection failures retain the destination and nested cause without URL credentials", async (t) => {
  const cause = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED", address: "127.0.0.1", port: 8000,
  });
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed", { cause }); });
  const events: TraceEvent[] = [];
  await assert.rejects(tracedFetch((e) => events.push(e), "container")(
    "http://user:password@localhost:8000/v1/chat/completions?key=private"));
  const failure = events.find((e) => e.kind === "model.http_error")!.detail as {
    endpoint: string; error: { cause: { code: string; port: number } };
  };
  assert.equal(failure.endpoint, "http://localhost:8000/v1/chat/completions");
  assert.equal(failure.error.cause.code, "ECONNREFUSED");
  assert.equal(failure.error.cause.port, 8000);
  assert.ok(!JSON.stringify(events).includes("password"));
  assert.ok(!JSON.stringify(events).includes("private"));
});

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

test("trace contexts retain provenance within an explicit aggregate budget", () => {
  const input = Array.from({ length: 105 }, (_, index) => ({ label: `Block ${index}`, text: index < 5
    ? "secret-key" + "x".repeat(20_000) : "small", source: { nodeId: `node-${index}`, kind: "output", token: "private" } }));
  const context = sanitizeTraceContext(input, ["secret-key"]);
  assert.equal(context.totalBlocks, 105);
  assert.equal(context.blocks.length, 100);
  assert.equal(context.omittedBlocks, 5);
  assert.equal(context.truncatedBlocks, 5);
  assert.ok(context.storedTextCharacters <= 65_536);
  assert.ok(context.blocks[0].text.startsWith("[redacted]"));
  assert.equal((context.blocks[0].source as { token: string }).token, "[redacted]");
  assert.equal(context.blocks[0].textTruncated, true);
  assert.equal(context.blocks[0].originalTextCharacters, 20_010);
  assert.ok(!JSON.stringify(context).includes("secret-key"));
  assert.ok(!JSON.stringify(context).includes("private"));
});

test("JSON metadata is redacted by key before trace persistence", () => {
  const value = sanitizeJsonText(JSON.stringify({ image: "safe", password: "private", nested: { api_key: "secret" } }));
  assert.deepEqual(JSON.parse(value!), { image: "safe", password: "[redacted]", nested: { api_key: "[redacted]" } });
  assert.equal(sanitize("https://example.com/data?token=private&view=full"),
    "https://example.com/data?token=[redacted]&view=full");
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
