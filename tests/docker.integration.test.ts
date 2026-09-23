import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, chmod, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInSandbox, sandboxStatus } from "../server/sandbox.ts";
import { withLocalModel, localCompletion } from "../server/localModels.ts";
import { sandboxModelUrl } from "../server/settings.ts";
import type { ContainerTrace } from "../server/containerTrace.ts";

test("real Docker: model networking, mounted workspace, logs, exit inspection and cancellation", {
  skip: process.env.MNEMONIC_TEST_DOCKER !== "1", timeout: 12 * 60 * 1000,
}, async (t) => {
  assert.equal((await sandboxStatus()).available, true, "Start Docker before running test:docker");
  const workspace = await mkdtemp(path.join(tmpdir(), "mnemonic-docker-workspace-"));
  await chmod(workspace, 0o777);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const mock = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const called = request.messages.some((m: {role: string}) => m.role === "tool");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ id: "chat", model: "test", choices: [{ index: 0, finish_reason: "stop", message: called
      ? { role: "assistant", content: "container finished" }
      : { role: "assistant", content: null, tool_calls: [
        { id: "write", type: "function", function: { name: "workspace_write", arguments: JSON.stringify({ path: "test/output.txt", content: "written in container" }) } },
        { id: "log", type: "function", function: { name: "log_tool", arguments: "{}" } },
      ] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  mock.listen(0, "0.0.0.0"); await once(mock, "listening");
  t.after(() => { mock.closeAllConnections(); mock.close(); });
  const port = (mock.address() as {port: number}).port;
  const job = { apiKey: "test-only", baseUrl: `http://host.docker.internal:${port}/v1`, provider: "compatible" as const,
    model: "test", input: "test", timeoutSec: 30, workspaces: ["/workspaces/test"],
    tools: [{ kind: "custom" as const, fnName: "log_tool", fnCode: 'console.log("tool diagnostic"); return "ok";' }] };
  let diagnostics: ContainerTrace | undefined;
  const result = await runInSandbox(job, [{ host: workspace, container: "/workspaces/test", name: "test" }], {
    timeoutSec: 30, onTrace: (trace) => { diagnostics = trace; },
  });
  assert.equal(result.result.ok, true);
  assert.equal(await readFile(path.join(workspace, "output.txt"), "utf8"), "written in container");
  assert.match(diagnostics!.stderr, /tool diagnostic/);
  assert.equal(diagnostics!.oomKilled, false);
  assert.equal(diagnostics!.exitCode, 0);
  const controller = new AbortController();
  await assert.rejects(runInSandbox(job, [], { timeoutSec: 30, signal: controller.signal,
    onEvent: (entry) => { if (entry.kind === "model.started") controller.abort(); },
    onTrace: (trace) => { diagnostics = trace; },
  }), /cancelled/);
  assert.match(diagnostics!.termination ?? "", /cancelled/);
});


test("real Docker node connects to its local inference worker and unloads it", {
  skip: process.env.MNEMONIC_TEST_DOCKER !== "1", timeout: 12 * 60 * 1000,
}, async (t) => {
  const gateway = createServer(async (req, res) => {
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      const result = await localCompletion(req.headers.authorization?.replace(/^Bearer /, "") ?? "", JSON.parse(body));
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result));
    } catch (err) { res.writeHead(400); res.end(JSON.stringify({ error: { message: (err as Error).message } })); }
  });
  gateway.listen(0, "0.0.0.0"); await once(gateway, "listening");
  t.after(() => { gateway.closeAllConnections(); gateway.close(); });
  const port = (gateway.address() as { port: number }).port;
  const events: string[] = [];
  const real = !!process.env.MNEMONIC_TEST_TRANSFORMERS;
  const model = real ? "HuggingFaceTB/SmolLM2-135M-Instruct" : "test";
  const result = await withLocalModel({ model,
    ...(real ? {} : { testWorker: { command: "python3", script: path.resolve("tests/fixtures/local-worker.py") } }),
    signal: AbortSignal.timeout(600_000), emit: (e) => events.push(e.kind) }, async ({ apiKey, baseUrl }) => {
    return runInSandbox({ apiKey, baseUrl: sandboxModelUrl(baseUrl), provider: "huggingface", model,
      effort: "off", input: "Say hello in one sentence.", timeoutSec: 60 }, [], { timeoutSec: 60 });
  }, port);
  assert.equal(result.result.ok, true, JSON.stringify(result.result));
  if (result.result.ok) assert.ok(result.result.result.text);
  assert.ok(events.includes("local.unloaded"));
});
