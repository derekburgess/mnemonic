import assert from "node:assert/strict";
import { test } from "node:test";
import { runStep } from "../src/api.ts";
import { commitRun, splitThinking, resolveContext, topoOrder } from "../src/graph.ts";
import type { InputNode } from "../src/types.ts";

const args = { model: "test", effort: "off" as const, input: "test", timeoutSec: 1,
  trace: { runId: "run", execId: "exec", kind: "step" as const, seq: 0, nodeId: "step", label: "Step", context: [] } };
const saved = { status: "ok", text: "output", model: "test" };
const accepted = () => Response.json({ runId: "run", execId: "exec", status: "accepted" }, { status: 202 });

test("an ambiguous admission retries with the same ID and collects the result", async (t) => {
  const identities: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url === "/api/trace/events") return Response.json({ ok: true });
    if (url === "/api/run") {
      identities.push(JSON.parse(init!.body as string).trace.execId);
      if (identities.length === 1) throw new TypeError("network lost");
      return accepted();
    }
    return Response.json(saved);
  });
  assert.equal((await runStep(args)).text, "output");
  assert.deepEqual(identities, ["exec", "exec"]);
});

test("admission errors do not start polling a nonexistent execution", async (t) => {
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url === "/api/trace/events") return Response.json({ ok: true });
    if (url !== "/api/run") polls++;
    return Response.json({ error: "Could not persist execution" }, { status: 503 });
  });
  await assert.rejects(runStep(args), /Could not persist execution/);
  assert.equal(polls, 0);
});

test("cancellation requests server termination", async (t) => {
  const controller = new AbortController();
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/cancel")) { cancelled = true; return Response.json({ cancelling: true }); }
    if (url === "/api/run") { controller.abort(); return accepted(); }
    return Response.json({ ok: true });
  });
  await assert.rejects(runStep(args, controller.signal), /cancelled/);
  assert.ok(cancelled);
});

test("recovery is idempotent and appended outputs retain existing graph connections", () => {
  const producer = { id: "step", type: "step", position: { x: 0, y: 0 }, data: { label: "Step" } } as InputNode;
  const result = { text: "saved", model: "test", effort: "off" as const, execId: "exec", runId: "run" };
  const first = commitRun([producer], [], producer, [result]);
  const again = commitRun(first.nodes, first.edges, producer, [result]);
  assert.equal(again.nodes.length, 2);
  assert.deepEqual(again.outputIds, first.outputIds);
  const next = commitRun(again.nodes, again.edges, producer, [{ ...result, execId: "sibling" }], { append: true });
  assert.equal(next.nodes.length, 3);
  assert.equal(next.edges.length, 2);
});

test("thinking blocks keep their exact tags and unmatched blocks remain in the answer", () => {
  const block = "<think> line one\nline two </think>";
  assert.deepEqual(splitThinking(block + "\n\nHello"), { thinking: block, answer: "Hello" });
  assert.deepEqual(splitThinking("<thinking>One</thinking>\n<think>Two</think>Done"), {
    thinking: "<thinking>One</thinking>\n\n<think>Two</think>", answer: "Done",
  });
  assert.deepEqual(splitThinking("<think>unfinished"), { thinking: "", answer: "<think>unfinished" });
  assert.deepEqual(splitThinking("  ordinary answer  "), { thinking: "", answer: "  ordinary answer  " });
});

test("thinking chains preserve recovery, fan-out and downstream connections on rerun", () => {
  const producer = { id: "step", type: "step", position: { x: 0, y: 0 }, data: { label: "Step" } } as InputNode;
  const consumer = { ...producer, id: "next", position: { x: 1000, y: 0 } };
  const result = { text: "<think>Reason</think>\nAnswer", model: "test", effort: "off" as const, execId: "exec" };
  const first = commitRun([producer, consumer], [{ id: "wire", source: "step", target: "next" }], producer, [result]);
  const thought = first.nodes.find((n) => n.type === "artifact" && n.data.kind === "thinking")!;
  assert.equal(thought.data.text, "<think>Reason</think>");
  assert.ok(first.edges.some((e) => e.source === "step" && e.target === thought.id));
  assert.ok(first.edges.some((e) => e.source === thought.id && e.target === first.outputIds[0]));
  assert.deepEqual(resolveContext("next", first.nodes, first.edges), [{ label: "Step", text: "Answer" }]);
  assert.deepEqual(topoOrder(first.nodes, first.edges).order, ["step", "next"]);
  const recovered = commitRun(first.nodes, first.edges, producer, [result]);
  assert.equal(recovered.nodes.length, first.nodes.length);
  assert.deepEqual(recovered.outputIds, first.outputIds);
  const second = commitRun(first.nodes, first.edges, producer, [
    { ...result, execId: "two" }, { ...result, execId: "three", text: "Plain" },
  ]);
  assert.equal(second.edges.filter((e) => e.target === "next").length, 2);
  assert.ok(!second.edges.some((e) => e.source === "step" && e.target === thought.id));
  assert.ok(!second.edges.some((e) => e.source === first.outputIds[0] && e.target === "next"));
  assert.deepEqual(resolveContext("next", second.nodes, second.edges).map((c) => c.text), ["Answer", "Plain"]);
});
