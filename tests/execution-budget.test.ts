import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInSandbox } from "../server/sandbox.ts";
import { fileURLToPath } from "node:url";
import { setTimeout as pause, setImmediate as nextTurn } from "node:timers/promises";
import { ExecutionBudget, executionClient, TIMEOUT_MESSAGE } from "../server/execution.ts";
import { runChat } from "../server/providers.ts";
import { buildTools } from "../server/tools.ts";
import { resolveLinks } from "../server/links.ts";
import type { TraceEvent } from "../server/events.ts";

const reply = JSON.stringify({ id: "test", model: "test", choices: [{ index: 0,
  message: { role: "assistant", content: "done" }, finish_reason: "stop" }] });
async function endpoint(t: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

// Undici exposes this clock specifically for tests; advance its old five-minute inactivity
// timer without making the regression suite or the node's actual deadline wait five minutes.
const httpClock = createRequire(import.meta.url)("undici/lib/util/timers.js") as { tick: (ms?: number) => void };

test("15-minute node budget survives five-minute HTTP header and body inactivity with tracing enabled", async (t) => {
  for (const phase of ["headers", "body"]) {
    let started!: () => void;
    const received = new Promise<void>((resolve) => { started = resolve; });
    let finish!: () => void;
    let calls = 0;
    const url = await endpoint(t, async (req, res) => {
      for await (const _ of req) { /* drain */ }
      calls++;
      res.setHeader("Content-Type", "application/json");
      if (phase === "body") res.write(reply.slice(0, 10));
      finish = () => res.end(phase === "body" ? reply.slice(10) : reply);
      started();
    });
    const budget = new ExecutionBudget(900);
    const events: TraceEvent[] = [];
    try {
      const client = executionClient({ apiKey: "local", baseUrl: url }, budget, true);
      const running = runChat({ client, transport: budget.fetch, signal: budget.signal, model: "test",
        input: "test", tools: [], dispatch: async () => "", onRound: () => {}, onEvent: (e) => events.push(e) });
      // Attach rejection handling before advancing the clock so a regression is an assertion.
      const result = running.then((value) => ({ value }), (error: Error) => ({ error }));
      await received;
      await pause(20);
      httpClock.tick(1);
      httpClock.tick(301_000);
      await nextTurn();
      finish();
      const settled = await result;
      assert.ok("value" in settled, "error" in settled ? settled.error.message : "");
      assert.equal(settled.value.text, "done");
      assert.equal(calls, 1);
      assert.equal(events.filter((e) => e.kind === "model.http_attempt").length, 1);
    } finally { finish?.(); await budget.dispose(); }
  }
});

test("a disconnected local generation is never retried", async (t) => {
  let calls = 0;
  const url = await endpoint(t, (req) => { calls++; req.socket.destroy(); });
  const budget = new ExecutionBudget(5);
  try {
    const client = executionClient({ apiKey: "local", baseUrl: url }, budget, true);
    await assert.rejects(runChat({ client, transport: budget.fetch, signal: budget.signal, model: "test",
      input: "test", tools: [], dispatch: async () => "", onRound: () => {}, onEvent: () => {} }));
    assert.equal(calls, 1);
  } finally { await budget.dispose(); }
});

test("preparation, links and tool calls share the remaining deadline", async (t) => {
  const url = await endpoint(t, () => { /* no headers: pending MCP initialization or link */ });
  for (const phase of ["mcp", "link", "tool"]) {
    const budget = new ExecutionBudget(0.2);
    try {
      await budget.wait(pause(80));
      const work = phase === "mcp"
        ? buildTools([{ kind: "mcp", label: "hung", serverUrl: `${url}/mcp` }], [], undefined, budget)
        : phase === "link"
          ? resolveLinks([url], budget.signal, budget.fetch)
          : buildTools([{ kind: "custom", fnName: "hung", fnCode: "await new Promise(r => setTimeout(r, 10000))" }], [], undefined, budget)
            .then(({ dispatch }) => dispatch("hung", "{}"));
      await assert.rejects(budget.wait(work), { name: "TimeoutError", message: TIMEOUT_MESSAGE });
    } finally { await budget.dispose(); }
  }
});

test("tools inherit the node budget and explicit shorter tool limits remain available", async () => {
  const budget = new ExecutionBudget(2);
  try {
    const { dispatch } = await buildTools([
      { kind: "custom", fnName: "normal", fnCode: "await new Promise(r => setTimeout(r, 50)); return 'ok'" },
      { kind: "custom", fnName: "short", timeoutSec: 0.01, fnCode: "await new Promise(r => setTimeout(r, 10000))" },
    ], [], undefined, budget);
    assert.equal(await dispatch("normal", "{}"), "ok");
    assert.match(await dispatch("short", "{}"), /tool code exceeded/);
    assert.equal(budget.signal.aborted, false);
  } finally { await budget.dispose(); }
});

async function runner(t: TestContext, job: Record<string, unknown>) {
  const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)),
    fileURLToPath(new URL("../server/runner.ts", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.resume();
  child.stdin.end(JSON.stringify({ apiKey: "local", provider: "huggingface", model: "test", input: "test", effort: "off", ...job }));
  await once(child, "close");
  return JSON.parse(stdout);
}

test("sandbox runner uses the inherited deadline and disables managed-local retries", async (t) => {
  let calls = 0;
  const url = await endpoint(t, (req, res) => { calls++; res.writeHead(500); res.end('{}'); });
  const failed = await runner(t, { baseUrl: url, managedLocal: true, timeoutSec: 900 });
  assert.equal(failed.ok, false);
  assert.equal(calls, 1);
  const expired = await runner(t, { baseUrl: url, managedLocal: true, timeoutSec: 900, deadlineMs: Date.now() - 1 });
  assert.equal(expired.status, 504);
  assert.equal(expired.error, TIMEOUT_MESSAGE);
  assert.equal(calls, 1, "expired preparation must never start generation");
  const pending = await endpoint(t, () => {});
  const timedOut = await runner(t, { baseUrl: pending, managedLocal: true, timeoutSec: 900, deadlineMs: Date.now() + 1000 });
  assert.equal(timedOut.status, 504);
  assert.equal(timedOut.error, TIMEOUT_MESSAGE);
});

test("the node deadline also stops Docker preparation before a container starts", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemonic-deadline-"));
  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}:${originalPath}`;
  t.after(async () => { process.env.PATH = originalPath; await rm(dir, { recursive: true, force: true }); });
  for (const phase of ["version", "image", "build"]) {
    await writeFile(path.join(dir, "docker"), `#!/bin/sh
if [ "$1" = "${phase}" ]; then exec sleep 10; fi
if [ "$1" = "image" ]; then exit 1; fi
if [ "$1" = "run" ]; then echo 'unexpected container launch' >&2; exit 1; fi
exit 0
`, { mode: 0o755 });
    const budget = new ExecutionBudget(0.1);
    const events: TraceEvent[] = [];
    try {
      await assert.rejects(runInSandbox({ apiKey: "local", provider: "huggingface", model: "test", input: "test",
        deadlineMs: budget.deadlineMs }, [], { timeoutSec: 900, signal: budget.signal, onEvent: (e) => events.push(e) }),
        { name: "TimeoutError", message: TIMEOUT_MESSAGE });
      assert.ok(!events.some((e) => e.kind === "container.starting"));
    } finally { await budget.dispose(); }
  }
});
