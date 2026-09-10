import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("migrated graph stays available when trace schema initialization fails", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemonic-isolation-"));
  await mkdir(path.join(dir, "data"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const store = new URL("../server/graphstore.ts", import.meta.url).href;
  const trace = new URL("../server/trace.ts", import.meta.url).href;
  const storage = new URL("../server/storage.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const {openDatabase} = await import(${JSON.stringify(storage)});
    const legacy = await openDatabase('data/mnemonic.duckdb');
    await legacy.conn.run("CREATE TABLE graph(id TEXT,nodes_json TEXT,edges_json TEXT,updated_ms BIGINT)");
    await legacy.conn.run("INSERT INTO graph VALUES ('current','[{\\"id\\":\\"preserved\\"}]','[]',1)");
    legacy.close();
    const {loadGraph,saveGraph} = await import(${JSON.stringify(store)});
    assert.equal((await loadGraph()).nodes[0].id,'preserved');
    const broken = await openDatabase('data/mnemonic.duckdb');
    await broken.conn.run('CREATE TABLE schema_version(version INTEGER)');
    await broken.conn.run('INSERT INTO schema_version VALUES (999)');
    broken.close();
    const {db} = await import(${JSON.stringify(trace)});
    await assert.rejects(db(),/newer/);
    const rev = await saveGraph([{id:'edited'}],[],1);
    await assert.rejects(saveGraph([],[],1),/newer graph/);
    assert.equal((await loadGraph()).nodes[0].id,'edited');
    assert.equal((await loadGraph()).updatedMs,rev);
  `], { cwd: dir, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
});
