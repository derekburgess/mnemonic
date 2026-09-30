import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTools } from "../server/tools.js";
import { describeWorkspaces } from "../server/workspace.js";
import { toolSpec } from "../src/api.js";

test("disabled tools are neither advertised nor dispatched, and MCP is never contacted", async () => {
  const { tools, dispatch } = await buildTools([
    { kind: "web_search", enabled: false },
    { kind: "mcp", label: "offline", serverUrl: "invalid URL", enabled: false },
    { kind: "custom", fnName: "blocked", fnParameters: "invalid JSON", enabled: false },
    { kind: "custom", fnName: "allowed", fnCode: 'return "ok";' },
  ]);
  assert.deepEqual(tools.map((t: any) => t.name), ["allowed"]);
  assert.match(await dispatch("blocked", "{}"), /unknown tool/);
  assert.equal(await dispatch("allowed", "{}"), "ok");
  for (const kind of ["web_search", "mcp", "custom"] as const) {
    assert.equal(toolSpec({ id: "1", label: "Test", kind, enabled: false }).enabled, false);
  }
});

test("workspace controls block writes while preserving reads and legacy defaults", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mnemonic-tools-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "test.txt");
  await fs.writeFile(file, "original");
  const controls = { workspace_write: false };
  const { tools, dispatch } = await buildTools([], [root], undefined, undefined, controls);
  assert.deepEqual(tools.map((t: any) => t.name), ["workspace_list", "workspace_read"]);
  const args = JSON.stringify({ path: `${path.basename(root)}/test.txt`, content: "changed" });
  assert.match(await dispatch("workspace_write", args), /unknown tool/);
  assert.equal(await fs.readFile(file, "utf8"), "original");
  assert.equal(JSON.parse(await dispatch("workspace_read", args)).content, "original");
  assert.doesNotMatch(describeWorkspaces([root], controls)!, /workspace_write/);
  const legacy = await buildTools([], [root]);
  assert.equal(legacy.tools.length, 3);
  assert.equal(JSON.parse(await legacy.dispatch("workspace_write", args)).written, true);
  assert.equal(await fs.readFile(file, "utf8"), "changed");
  const disabled = { workspace_write: false, workspace_read: false, workspace_list: false };
  assert.equal((await buildTools([], [root], undefined, undefined, disabled)).tools.length, 0);
  assert.equal(describeWorkspaces([root], disabled), undefined);
});
