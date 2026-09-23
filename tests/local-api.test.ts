import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, copyFile, writeFile, symlink, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
test("fresh local-only setup delivers outputs and actionable node errors through the API", { timeout: 20_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemonic-local-api-"));
  await mkdir(path.join(dir, "local-model"));
  await copyFile(path.join(root, "tests/fixtures/local-worker.py"), path.join(dir, "local-model/worker.py"));
  for (const file of ["Dockerfile", "requirements.txt"]) await copyFile(path.join(root, "local-model", file), path.join(dir, "local-model", file));
  await symlink(path.join(root, "server"), path.join(dir, "server"));
  await symlink(path.join(root, "sandbox"), path.join(dir, "sandbox"));
  await writeFile(path.join(dir, "docker"), `#!/usr/bin/env python3
import json, sys, subprocess, os
if sys.argv[1] == 'run':
    job = json.load(sys.stdin)
    job['baseUrl'] = job['baseUrl'].replace('host.docker.internal', '127.0.0.1')
    with open('docker-runs', 'a') as log: log.write('run\\n')
    result = subprocess.run(${JSON.stringify([process.execPath, "--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "server/runner.ts")])}, input=json.dumps(job).encode())
    sys.exit(result.returncode)
elif sys.argv[1] == 'start':
    os.execvp('python3', ['python3', 'local-model/worker.py'])
elif sys.argv[1] == 'inspect':
    print(json.dumps({'OOMKilled': False, 'ExitCode': 0}))
elif sys.argv[1] == 'version':
    print('test-docker')
`, { mode: 0o755 });
  const child = spawn(process.execPath, ["--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "server/index.ts")], {
    cwd: dir, env: { ...process.env, OPENAI_API_KEY: "", PORT: "0", PATH: `${dir}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } await rm(dir, { recursive: true, force: true }); });
  const base = await new Promise<string>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; const match = output.match(/proxy listening on (http:\/\/localhost:\d+)/); if (match) resolve(match[1]); });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("exit", () => reject(new Error(output)));
  });
  const post = (endpoint: string, body: unknown) => fetch(`${base}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const settings = await post("/api/settings", { provider: "huggingface", runLocally: true });
  assert.equal(settings.status, 200);
  assert.equal((await settings.json()).runLocally, true);
  assert.deepEqual((await (await fetch(`${base}/api/models`)).json()).models, []);
  for (const model of ["test", "load-error", "inference-error"]) {
    assert.equal((await post("/api/run", { model, sandbox: false, input: "Hello", effort: "off", timeoutSec: 5,
      trace: { runId: "local", execId: model, nodeId: "step" } })).status, 202);
    let result;
    for (let i = 0; i < 150; i++) {
      result = await (await fetch(`${base}/api/executions/local/${model}`)).json();
      if (result.status !== "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(result.status, model === "test" ? "ok" : "error", JSON.stringify(result));
    if (model === "test") assert.equal(result.text, "local worker output");
    else assert.match(result.error, /memory|RAM/);
  }
  assert.ok((await readFile(path.join(dir, "docker-runs"), "utf8")).includes("run"), "local execution must enter Docker even when sandbox:false is submitted");
  const { steps } = await (await fetch(`${base}/api/trace/runs/local`)).json();
  for (const step of steps) assert.ok(step.events.some((e: { kind: string }) => e.kind === "local.unloaded"));
  assert.equal((await (await fetch(`${base}/api/local-model/status`)).json()).activity, null);
});
