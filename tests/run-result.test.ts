import assert from "node:assert/strict";
import { test } from "node:test";
import { runStep } from "../src/api.ts";
import { commitRun } from "../src/graph.ts";
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
