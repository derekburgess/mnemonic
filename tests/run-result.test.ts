import assert from "node:assert/strict";
import { test } from "node:test";
import { runStep } from "../src/api.ts";
import { commitRun, composePrompt, composeSystem, splitThinking, resolveContext, resolveInheritedInput, topoOrder } from "../src/graph.ts";
import type { CommentNode, ContextNode, InputNode } from "../src/types.ts";

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

test("fan-out outputs form a compact staggered cluster away from their producer", () => {
  const producer = { id: "step", type: "step", position: { x: 40, y: 60 }, data: { label: "Step" } } as InputNode;
  const committed = commitRun([producer], [], producer, ["one", "two", "three"].map((text, index) => ({
    text, model: "test", effort: "off" as const, execId: `output-${index}`,
  })));
  const outputs = committed.outputIds.map((id) => committed.nodes.find((node) => node.id === id)!);

  assert.ok(outputs.every((node) => node.position.x - (producer.position.x + 300) >= 120));
  assert.ok(outputs[1].position.x > outputs[0].position.x);
  assert.ok(outputs[1].position.y > outputs[0].position.y);
  assert.ok(outputs[2].position.x > outputs[1].position.x);
  assert.ok(outputs[2].position.y < outputs[1].position.y);
  assert.ok(Math.max(...outputs.map((node) => node.position.y)) - Math.min(...outputs.map((node) => node.position.y)) < 150);

  const next = commitRun(committed.nodes, committed.edges, producer, ["four", "five", "six"].map((text, index) => ({
    text, model: "test", effort: "off" as const, execId: `next-${index}`,
  })));
  const nextOutputs = next.outputIds.map((id) => next.nodes.find((node) => node.id === id)!);
  const firstRight = Math.max(...outputs.map((node) => node.position.x)) + 300;
  const nextLeft = Math.min(...nextOutputs.map((node) => node.position.x));
  assert.ok(nextOutputs[0].position.x > outputs[0].position.x);
  assert.ok(nextOutputs[0].position.y > outputs[0].position.y);
  assert.ok(nextOutputs[0].position.y - outputs[0].position.y > 300);
  assert.ok(nextLeft > firstRight);
  assert.equal(nextOutputs[0].data.outputSetIndex, 1);

  const third = commitRun(next.nodes, next.edges, producer, ["seven", "eight", "nine"].map((text, index) => ({
    text, model: "test", effort: "off" as const, execId: `third-${index}`,
  })));
  const thirdOutputs = third.outputIds.map((id) => third.nodes.find((node) => node.id === id)!);
  const nextTop = Math.min(...nextOutputs.map((node) => node.position.y));
  const thirdBottom = Math.max(...thirdOutputs.map((node) => node.position.y)) + 336;
  assert.equal(thirdOutputs[0].position.x, nextOutputs[0].position.x);
  assert.ok(thirdOutputs[0].position.y < nextOutputs[0].position.y);
  assert.ok(thirdOutputs[0].position.y < outputs[0].position.y);
  assert.ok(thirdBottom < nextTop);
  assert.equal(thirdOutputs[0].data.outputSetIndex, 2);
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
  const firstContext = resolveContext("next", first.nodes, first.edges);
  assert.deepEqual(firstContext.map(({ label, text }) => ({ label, text })), [{ label: "Step", text: "Answer" }]);
  assert.equal(firstContext[0].source?.kind, "output");
  assert.equal(firstContext[0].source?.nodeId, first.outputIds[0]);
  assert.equal(firstContext[0].source?.execId, "exec");
  assert.ok(firstContext[0].source?.outputSetId);
  const editedNodes = first.nodes.map((node) => node.id === first.outputIds[0]
    ? { ...node, data: { ...node.data, edited: true } } : node) as typeof first.nodes;
  assert.equal(resolveContext("next", editedNodes, first.edges)[0].source?.edited, true);
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

test("loop iterations append outputs and move selected routes to the latest output set", () => {
  const producer = { id: "step", type: "step", position: { x: 0, y: 0 }, data: { label: "Loop", loop: true } } as InputNode;
  const consumer = { ...producer, id: "transform", data: { ...producer.data, label: "Transform", loop: false }, position: { x: 1200, y: 0 } };
  const result = { text: "first", model: "test", effort: "off" as const, execId: "first" };
  const options = { append: true, moveRoutes: true };
  const first = commitRun([producer, consumer], [], producer, [result], options);
  const linked = [...first.edges, { id: "selected", source: first.outputIds[0], target: consumer.id },
    { id: "feedback", source: first.outputIds[0], target: producer.id }];
  const second = commitRun(first.nodes, linked, producer, [{ ...result, text: "second", execId: "second" }], options);
  assert.ok(second.edges.some((edge) => edge.source === producer.id && edge.target === first.outputIds[0]));
  assert.ok(!second.edges.some((edge) => edge.id === "selected" || edge.id === "feedback"));
  assert.ok(second.edges.some((edge) => edge.source === second.outputIds[0] && edge.target === consumer.id));
  assert.ok(second.edges.some((edge) => edge.source === second.outputIds[0] && edge.target === producer.id));
  assert.deepEqual(resolveContext(consumer.id, second.nodes, second.edges).map((c) => c.text), ["second"]);
  assert.deepEqual(resolveContext(producer.id, second.nodes, second.edges).map((c) => c.text), ["second"]);
  assert.equal(second.nodes.length, 4);
});

test("all-output loops retain every iteration route and provide ordered accumulated context", () => {
  const producer = { id: "step", type: "step", position: { x: 0, y: 0 }, data: { label: "Loop", loop: true, loopOutputMode: "all" } } as InputNode;
  const consumer = { ...producer, id: "next", data: { ...producer.data, label: "Next", loop: false }, position: { x: 1200, y: 0 } };
  const options = { append: true };
  const first = commitRun([producer, consumer], [], producer,
    [{ text: "first", model: "test", effort: "off", execId: "first" }], options);
  const linked = [...first.edges, { id: "selected", source: first.outputIds[0], target: consumer.id }];
  const second = commitRun(first.nodes, linked, producer,
    [{ text: "second", model: "test", effort: "off", execId: "second" }], options);

  assert.ok(second.edges.some((edge) => edge.id === "selected"));
  assert.ok(second.edges.some((edge) => edge.source === second.outputIds[0] && edge.target === consumer.id));
  assert.deepEqual(resolveContext(consumer.id, second.nodes, second.edges).map((c) => c.text), ["first", "second"]);
});


test("context nodes pass prompts, system fields, and resources through without being scheduled", () => {
  const upstream = { id: "upstream", type: "step", position: { x: 0, y: 0 }, data: {
    label: "Upstream", model: "test", effort: "off", prompt: "Run first", outputs: 1, status: "idle",
  } } as InputNode;
  const context = { id: "context", type: "context", position: { x: 400, y: 0 }, data: {
    label: "Research", role: "Analyst", instructions: "Cite the evidence.", prompt: "Use these details",
    attachments: [{ id: "skill", name: "guide.md", text: "Standing guidance" }],
    files: [{ id: "file", name: "source.txt", mime: "text/plain", dataUrl: "data:text/plain;base64,U291cmNl" }],
    links: [{ id: "link", url: "https://example.com" }],
    workspaces: [{ id: "workspace", path: "/tmp/project" }],
  } } as ContextNode;
  const consumer = { id: "consumer", type: "step", position: { x: 800, y: 0 }, data: {
    label: "Consumer", model: "test", effort: "off", prompt: "Answer", outputs: 1, status: "idle",
  } } as InputNode;
  const output = { id: "output", type: "artifact", position: { x: 200, y: 0 }, data: {
    sourceId: upstream.id, sourceLabel: upstream.data.label, model: "test", effort: "off",
    text: "Upstream answer", createdAt: 1,
  } } as const;
  const nodes = [upstream, output, context, consumer];
  const edges = [
    { id: "one", source: output.id, target: context.id },
    { id: "two", source: context.id, target: consumer.id },
  ];

  assert.deepEqual(topoOrder(nodes, edges).order, ["upstream", "consumer"]);
  const inherited = resolveInheritedInput(consumer.id, nodes, edges);
  assert.deepEqual({ ...inherited, context: inherited.context.map(({ label, text }) => ({ label, text })) }, {
    context: [
      { label: "Upstream", text: "Upstream answer" },
      { label: "Research", text: "Use these details" },
    ],
    roles: ["Analyst"],
    instructions: ["Cite the evidence."],
    attachments: context.data.attachments,
    files: context.data.files,
    links: context.data.links,
    workspaces: context.data.workspaces,
  });
  assert.deepEqual(inherited.context.map((block) => block.source?.kind), ["output", "context"]);
  assert.deepEqual(inherited.context.map((block) => block.source?.nodeId), ["output", "context"]);
  assert.equal(composeSystem(inherited.roles, inherited.instructions, inherited.attachments),
    "Your role is: Analyst\n\nCite the evidence.\n\n<document name=\"guide.md\">\nStanding guidance\n</document>");
});

test("comments contribute attributed context without becoming scheduled steps", () => {
  const comment = { id: "comment", type: "comment", position: { x: 0, y: 0 }, data: {
    author: "Ada", text: "Check the **assumptions**.", createdAt: 1,
    replies: [
      { id: "reply", author: "Grace", text: "I checked the edge cases.", createdAt: 2 },
      { id: "empty", author: "Linus", text: "", createdAt: 3 },
    ],
  } } as CommentNode;
  const consumer = { id: "consumer", type: "step", position: { x: 500, y: 0 }, data: {
    label: "Consumer", model: "test", effort: "off", prompt: "Revise", outputs: 1, status: "idle",
  } } as InputNode;
  const nodes = [comment, consumer];
  const edges = [{ id: "context", source: comment.id, target: consumer.id }];

  assert.deepEqual(topoOrder(nodes, edges), { order: [consumer.id], cycle: [] });
  const context = resolveContext(consumer.id, nodes, edges);
  assert.deepEqual(context.map(({ label, text }) => ({ label, text })), [
    { label: "Ada", text: "Check the **assumptions**." },
    { label: "Grace", text: "I checked the edge cases." },
  ]);
  assert.deepEqual(context.map((block) => block.source), [
    { nodeId: "comment", kind: "comment", createdAt: 1 },
    { nodeId: "comment", kind: "reply", replyId: "reply", createdAt: 2 },
  ]);
  assert.equal(composePrompt(resolveContext(consumer.id, nodes, edges), consumer.data.prompt),
    '<context from="Ada">\nCheck the **assumptions**.\n</context>\n\n' +
    '<context from="Grace">\nI checked the edge cases.\n</context>\n\nRevise');
});
