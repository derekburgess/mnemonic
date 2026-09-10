import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { containerLogger, type ContainerTrace } from "../server/containerTrace.ts";
import { runInSandbox } from "../server/sandbox.ts";
import type { StepTrace } from "../server/trace.ts";
import { event, type TraceEvent } from "../server/events.ts";

test("logs redact credentials across chunks and bound retained output", () => {
  const logger = containerLogger(["secret-key"]);
  logger.stderr("authorization: secret-");
  logger.stderr("key\n");
  assert.equal(logger.snapshot().stderr, "authorization: [redacted]\n");
  logger.stderr("x".repeat(70_000));
  logger.stderr("secret-key");
  logger.event("error secret-key");
  const trace = logger.snapshot();
  assert.equal(trace.truncated, true);
  assert.ok(trace.stderr.length <= 65_536);
  assert.ok(!JSON.stringify(trace).includes("secret-key"));
});

test("container diagnostics survive success, invalid output, and process failure", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemonic-docker-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });
  for (const scenario of ["success", "invalid", "failure", "oom"]) {
    await writeFile(path.join(dir, "docker"), `#!/bin/sh
case "$1" in
version) echo test ;;
image) exit 0 ;;
inspect) echo '{"OOMKilled":${scenario === "oom"},"ExitCode":${scenario === "oom" ? 137 : 0}}' ;;
rm) exit 0 ;;
run)
  cat >/dev/null
  echo 'tool log secret-key' >&2
  printf '\\036%s\\n' '{"id":"resource-event","at":1,"source":"container","kind":"runner.resources","detail":{"peakMemoryBytes":1234}}' >&2
  ${scenario === "success" ? `echo '{"ok":true,"result":{"text":"done"},"rounds":[]}'` : scenario === "invalid" ? "echo invalid-json" : scenario === "oom" ? "exit 137" : "exit 17"}
  ;;
esac
`, { mode: 0o755 });
    const captured: ContainerTrace[] = [];
    const events: TraceEvent[] = [];
    const result = runInSandbox({ apiKey: "secret-key", provider: "openai", model: "test", input: "test" }, [], {
      timeoutSec: 1, onTrace: (trace) => captured.push(trace), onEvent: (entry) => events.push(entry),
    });
    if (scenario === "success") assert.equal((await result).result.ok, true);
    else await assert.rejects(result, scenario === "invalid" ? /unreadable/ : scenario === "oom" ? /exited \(137\)/ : /exited \(17\)/);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].stderr, "tool log [redacted]\n");
    assert.equal(captured[0].exitCode, scenario === "failure" ? 17 : scenario === "oom" ? 137 : 0);
    assert.equal(captured[0].peakMemoryBytes, 1234);
    assert.equal(captured[0].oomKilled, scenario === "oom");
    if (scenario === "oom") assert.equal(captured[0].termination, "out of memory");
    assert.ok(captured[0].image?.startsWith("mnemonic-sandbox:"));
    assert.ok(captured[0].events.some((e) => e.message === "Container cleanup attempted"));
    assert.ok(events.some((e) => e.kind === "container.exited"));
    assert.ok(events.some((e) => e.kind === "container.log"));
  }
});

test("trace storage returns container diagnostics and accepts older traces", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemonic-trace-test-"));
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });
  const { db, recordStep, getRun, getStepResult, recordEvent, getRunProgress, markInterrupted } = await import("../server/trace.ts");
  const logger = containerLogger([]);
  logger.event("Runner completed");
  logger.stderr("Tool diagnostic\n");
  const step: StepTrace = {
    execId: "execution", runId: "run", kind: "step", seq: 0, nodeId: "step", label: "Step",
    requestedModel: "test", servedModel: "test", effort: "off", startedMs: 1, finishedMs: 2,
    status: "ok", error: null, systemPrompt: null, inputPrompt: "test", context: [], tools: [],
    rounds: [], params: {}, files: [], links: [], toolCalls: [], outputText: "done", usage: null,
    container: logger.snapshot(),
  };
  try {
    await recordStep({ ...step, status: "running", finishedMs: null });
    const started = event("container", "model.started", { round: 1 });
    await recordEvent("run", "execution", started);
    await recordEvent("run", "execution", started);
    assert.equal((await getStepResult("run", "execution"))?.status, "pending");
    assert.equal((await getRunProgress("run")).events.length, 1);
    await markInterrupted();
    assert.equal((await getRun("run"))[0].status, "interrupted");
    assert.equal((await getStepResult("run", "execution"))?.status, "error");
    await recordStep(step);
    assert.deepEqual((await getRun("run"))[0].container, step.container);
    assert.equal((await getStepResult("run", "execution"))?.text, "done");
    await recordEvent("run", "execution", event("browser", "graph.committed", { outputId: "artifact" }));
    assert.equal((await getRun("run"))[0].delivery, "added to graph");
    await recordStep({ ...step, execId: "old", container: undefined });
    assert.equal((await getRun("run")).find((s) => s.execId === "old")?.container, null);
  } finally {
    (await db()).closeSync();
  }
});
