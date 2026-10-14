import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("trace histories are isolated by canvas and survive an archive round trip", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemonic-trace-canvas-"));
  await mkdir(path.join(dir, "data"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const traceUrl = new URL("../server/trace.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const trace = await import(${JSON.stringify(traceUrl)});
    const step = (canvasId, runId, execId) => ({ canvasId, runId, execId, kind:'step', seq:0,
      nodeId:'node', label:canvasId, requestedModel:'test', servedModel:'test', effort:'off',
      startedMs:1, finishedMs:2, status:'ok', error:null, systemPrompt:null, inputPrompt:'input',
      context:[], tools:[], rounds:[], params:{}, files:[], links:[], toolCalls:[], outputText:'output', usage:{} });
    await trace.recordStep(step('canvas-a','run-a','exec-a'));
    await trace.recordStep(step('canvas-b','run-b','exec-b'));
    assert.deepEqual((await trace.listRuns('canvas-a')).map(x => x.runId), ['run-a']);
    assert.deepEqual((await trace.listRuns('canvas-b')).map(x => x.runId), ['run-b']);
    const archive = await trace.exportCanvasTraces('canvas-a');
    await trace.recordStep(step('canvas-a','run-extra','exec-extra'));
    await trace.importCanvasTraces('canvas-a', archive);
    assert.deepEqual((await trace.listRuns('canvas-a')).map(x => x.runId), ['run-a']);
    assert.deepEqual((await trace.listRuns('canvas-b')).map(x => x.runId), ['run-b']);
    assert.equal((await trace.getRun('run-a','canvas-b')).length, 0);
    await trace.deleteRun('run-b','canvas-a');
    assert.deepEqual((await trace.listRuns('canvas-b')).map(x => x.runId), ['run-b']);
    await trace.importCanvasTraces('canvas-b', { version:1, runs:[] });
    assert.deepEqual(await trace.listRuns('canvas-b'), []);
  `], { cwd: dir, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
});
