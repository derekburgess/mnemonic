import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("replays the old sequence-default WAL after a crash without losing graph or events", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "mnemonic-recovery-test-"));
  await mkdir(path.join(dir, "data"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const duckdb = fileURLToPath(new URL("../node_modules/@duckdb/node-api/lib/index.js", import.meta.url));
  const fixture = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import {DuckDBInstance} from ${JSON.stringify(duckdb)};
    const instance = await DuckDBInstance.create('data/mnemonic.duckdb');
    const c = await instance.connect();
    await c.run("CREATE TABLE graph(id TEXT PRIMARY KEY,nodes_json TEXT,edges_json TEXT,updated_ms BIGINT)");
    await c.run("INSERT INTO graph VALUES ('current','[{\\"id\\":\\"kept\\"}]','[]',123)");
    await c.run("CREATE TABLE trace_events(id TEXT PRIMARY KEY,run_id TEXT,exec_id TEXT,at_ms BIGINT,received_ms BIGINT,source TEXT,kind TEXT,detail_json TEXT)");
    await c.run("CHECKPOINT");
    await c.run("CREATE SEQUENCE trace_event_order START 1");
    await c.run("ALTER TABLE trace_events ADD COLUMN event_order BIGINT DEFAULT nextval('trace_event_order')");
    await c.run("INSERT INTO trace_events(id,run_id,exec_id,at_ms,received_ms,source,kind) VALUES ('before','run','exec',1,1,'proxy','request.accepted')");
    process.kill(process.pid, 'SIGKILL');
  `], { cwd: dir, encoding: "utf8" });
  assert.equal(fixture.signal, "SIGKILL", fixture.stderr);

  const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
  const trace = new URL("../server/trace.ts", import.meta.url).href;
  const graph = new URL("../server/graphstore.ts", import.meta.url).href;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reopened = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      const {db,getEvents,recordEvent} = await import(${JSON.stringify(trace)});
      const {loadGraph} = await import(${JSON.stringify(graph)});
      assert.equal((await loadGraph()).nodes[0].id, 'kept');
      const events = await getEvents('run');
      assert.equal(events.length, ${attempt + 1});
      assert.equal(events[0].id, 'before');
      await recordEvent('run','exec',{id:'after-${attempt}',at:${attempt + 2},source:'proxy',kind:'result.saved'});
      process.kill(process.pid,'SIGKILL');
    `], { cwd: dir, encoding: "utf8" });
    assert.equal(reopened.signal, "SIGKILL", reopened.stderr);
  }
});
