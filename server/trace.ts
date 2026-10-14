import { openDatabase, migrateDatabase } from "./storage.js";
import path from "node:path";
import { type DuckDBConnection } from "@duckdb/node-api";
import { sanitize, deliveryState, type TraceEvent } from "./events.js";
import type { ContainerTrace } from "./containerTrace.js";
import { LEGACY_CANVAS_ID } from "../src/canvasIdentity.js";

const DB_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "mnemonic.duckdb");

/** One execution of one step, captured in full. */
export type StepTrace = {
  canvasId?: string;
  execId: string;
  runId: string;
  kind: string;
  seq: number;
  nodeId: string;
  label: string;
  requestedModel: string;
  servedModel: string | null;
  effort: string;
  startedMs: number;
  finishedMs: number | null;
  status: "running" | "ok" | "error" | "interrupted" | "cancelled";
  error: string | null;
  systemPrompt: string | null;
  inputPrompt: string;
  context: unknown;
  tools: unknown;
  /** Every request/response pair in the tool loop, including reasoning items verbatim. */
  rounds: unknown;
  /** The step's own limits, so a run that hit one can be read back against them. */
  params: unknown;
  /** What was attached and what each link resolved to. */
  files: unknown;
  links: unknown;
  toolCalls: unknown;
  outputText: string | null;
  usage: unknown;
  container?: ContainerTrace | null;
};

let connection: DuckDBConnection | null = null;

/** Opened lazily so the proxy still starts if the database cannot be created. */
let opening: Promise<DuckDBConnection> | null = null;
export function db(): Promise<DuckDBConnection> {
  return opening ??= openDb().catch((err) => { opening = null; throw err; });
}
async function openDb(): Promise<DuckDBConnection> {
  if (connection) return connection;

  const database = await openDatabase(DB_PATH);
  const { conn } = database;
  try {
    await migrateDatabase(conn, DB_PATH, 3, async () => {
      // Legacy traces are intentionally discarded. Rebuilding their tables avoids asking
      // DuckDB to bulk-delete rows through indexes created by older schema revisions.
      await conn.run(`DROP TABLE IF EXISTS trace_events`);
      await conn.run(`DROP TABLE IF EXISTS step_runs`);
      await conn.run(`DROP TABLE IF EXISTS runs`);
      await conn.run(`DROP SEQUENCE IF EXISTS trace_event_order`);

      await conn.run(`
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          kind TEXT,
          started_ms BIGINT,
          finished_ms BIGINT,
          canvas_id TEXT
        )`);
      await conn.run(`CREATE INDEX runs_canvas ON runs(canvas_id, started_ms)`);
      await conn.run(`
        CREATE TABLE step_runs (
          exec_id TEXT PRIMARY KEY,
          run_id TEXT,
          seq INTEGER,
          node_id TEXT,
          label TEXT,
          requested_model TEXT,
          served_model TEXT,
          effort TEXT,
          started_ms BIGINT,
          finished_ms BIGINT,
          status TEXT,
          error TEXT,
          system_prompt TEXT,
          input_prompt TEXT,
          context_json TEXT,
          tools_json TEXT,
          rounds_json TEXT,
          tool_calls_json TEXT,
          output_text TEXT,
          usage_json TEXT,
          params_json TEXT,
          files_json TEXT,
          links_json TEXT,
          container_json TEXT
        )`);
      await conn.run(`CREATE TABLE trace_events (
        id TEXT PRIMARY KEY, run_id TEXT, exec_id TEXT, at_ms BIGINT, received_ms BIGINT,
        source TEXT, kind TEXT, detail_json TEXT, event_order BIGINT)`);
      await conn.run(`CREATE SEQUENCE trace_event_order START 1`);
      await conn.run(`CREATE INDEX trace_events_step ON trace_events(run_id, exec_id)`);

    });

    connection = conn;
    return conn;
  } catch (err) {
    database.close();
    throw err;
  }
}

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export async function recordStep(t: StepTrace): Promise<void> {
  const conn = await db();

  // The run row is created by whichever step arrives first, then extended as more land.
  await conn.run(
    `INSERT INTO runs (run_id, kind, started_ms, finished_ms, canvas_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (run_id) DO UPDATE SET
       finished_ms = greatest(runs.finished_ms, excluded.finished_ms),
       started_ms = least(runs.started_ms, excluded.started_ms),
       canvas_id = excluded.canvas_id`,
    [t.runId, t.kind, BigInt(t.startedMs), t.finishedMs === null ? null : BigInt(t.finishedMs), t.canvasId ?? LEGACY_CANVAS_ID],
  );

  // Named columns rather than positional, so adding one later cannot silently shift the rest.
  await conn.run(
    `INSERT OR REPLACE INTO step_runs (
       exec_id, run_id, seq, node_id, label,
       requested_model, served_model, effort,
       started_ms, finished_ms, status, error,
       system_prompt, input_prompt,
       context_json, tools_json, rounds_json, tool_calls_json,
       output_text, usage_json, params_json, files_json, links_json, container_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [
      t.execId, t.runId, t.seq, t.nodeId, t.label,
      t.requestedModel, t.servedModel, t.effort,
      BigInt(t.startedMs), t.finishedMs === null ? null : BigInt(t.finishedMs),
      t.status, t.error,
      t.systemPrompt, t.inputPrompt,
      json(t.context), json(t.tools), json(t.rounds), json(t.toolCalls),
      t.outputText, json(t.usage), json(t.params), json(t.files), json(t.links),
      json(t.container),
    ],
  );
}

/** Bigints come back from DuckDB as BigInt; JSON columns as strings. */
const num = (v: unknown) => (typeof v === "bigint" ? Number(v) : (v as number | null));
const parse = (v: unknown) => {
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

export async function listRuns(canvasId = LEGACY_CANVAS_ID, limit = 100) {
  const conn = await db();
  const reader = await conn.runAndReadAll(
    `SELECT r.run_id, r.kind, r.started_ms, r.finished_ms,
            count(s.exec_id) AS steps,
            sum(CASE WHEN s.status = 'running' THEN 1 ELSE 0 END) AS running,
            sum(CASE WHEN s.status IN ('error', 'interrupted') THEN 1 ELSE 0 END) AS errors,
            string_agg(DISTINCT s.requested_model, ', ') AS models
     FROM runs r LEFT JOIN step_runs s USING (run_id)
     WHERE r.canvas_id=$1
     GROUP BY ALL ORDER BY r.started_ms DESC LIMIT $2`,
    [canvasId, limit],
  );
  return reader.getRowObjects().map((r) => ({
    runId: r.run_id as string,
    kind: r.kind as string,
    startedMs: num(r.started_ms),
    finishedMs: num(r.finished_ms),
    steps: num(r.steps) ?? 0,
    running: num(r.running) ?? 0,
    errors: num(r.errors) ?? 0,
    models: (r.models as string) ?? "",
  }));
}

/**
 * Just the result of one step execution, without the rounds.
 *
 * A step is written here before its response is sent, so this is what lets a run whose HTTP
 * connection died still be collected. It is polled while waiting, which is why it selects
 * columns rather than `*` — `rounds_json` alone can be megabytes, and none of it is needed to
 * put an artifact on the canvas.
 */
export async function getStepResult(runId: string, execId: string) {
  const conn = await db();
  const reader = await conn.runAndReadAll(
    `SELECT status, error, served_model, requested_model, output_text, usage_json, tool_calls_json, params_json
       FROM step_runs WHERE run_id = $1 AND exec_id = $2`,
    [runId, execId],
  );
  const row = reader.getRowObjects()[0];
  if (!row) return null;
  return {
    status: row.status === "running" ? "pending" : (row.status === "interrupted" || row.status === "cancelled") ? "error" : row.status as string,
    error: row.error as string | null,
    model: (row.served_model as string | null) ?? (row.requested_model as string),
    text: (row.output_text as string | null) ?? "",
    usage: parse(row.usage_json),
    toolCalls: parse(row.tool_calls_json),
    workspaceChanges: (parse(row.params_json) as { workspaceChanges?: string } | null)?.workspaceChanges,
  };
}

export async function getRun(runId: string, canvasId = LEGACY_CANVAS_ID) {
  const conn = await db();
  const reader = await conn.runAndReadAll(
    `SELECT s.* FROM step_runs s JOIN runs r USING (run_id)
     WHERE s.run_id = $1 AND r.canvas_id = $2 ORDER BY s.seq, s.started_ms`,
    [runId, canvasId],
  );
  const events = await getEvents(runId);
  return reader.getRowObjects().map((r) => ({
    events: events.filter((e) => e.execId === r.exec_id),
    delivery: deliveryState(events.filter((e) => e.execId === r.exec_id)),
    execId: r.exec_id as string,
    runId,
    seq: num(r.seq),
    nodeId: r.node_id as string,
    label: r.label as string,
    requestedModel: r.requested_model as string,
    servedModel: r.served_model as string | null,
    effort: r.effort as string,
    startedMs: num(r.started_ms),
    finishedMs: num(r.finished_ms),
    status: r.status as string,
    error: r.error as string | null,
    systemPrompt: r.system_prompt as string | null,
    inputPrompt: r.input_prompt as string,
    context: parse(r.context_json),
    tools: parse(r.tools_json),
    rounds: parse(r.rounds_json),
    toolCalls: parse(r.tool_calls_json),
    outputText: r.output_text as string | null,
    usage: parse(r.usage_json),
    params: parse(r.params_json),
    files: parse(r.files_json),
    links: parse(r.links_json),
    container: parse(r.container_json),
  }));
}

export async function deleteRun(runId: string, canvasId = LEGACY_CANVAS_ID): Promise<void> {
  const conn = await db();
  const owned = `(SELECT run_id FROM runs WHERE run_id=$1 AND canvas_id=$2)`;
  await conn.run(`DELETE FROM trace_events WHERE run_id IN ${owned}`, [runId, canvasId]);
  await conn.run(`DELETE FROM step_runs WHERE run_id IN ${owned}`, [runId, canvasId]);
  await conn.run(`DELETE FROM runs WHERE run_id = $1 AND canvas_id=$2`, [runId, canvasId]);
}

/** Events are independent writes, so progress survives a lost final response or proxy crash. */
export async function recordEvent(runId: string, execId: string, e: TraceEvent, canvasId?: string): Promise<void> {
  const conn = await db();
  await conn.run(`INSERT INTO trace_events (id,run_id,exec_id,at_ms,received_ms,source,kind,detail_json,event_order)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,nextval('trace_event_order')
    WHERE ($9 IS NULL OR EXISTS (SELECT 1 FROM runs WHERE run_id=$2 AND canvas_id=$9))
      AND (SELECT count(*) FROM trace_events WHERE run_id=$2 AND exec_id=$3) < CASE WHEN $7 IN ('graph.committed','graph.failed','execution.completed','execution.failed','result.saved','delivery.received','delivery.recovered') THEN 2500 ELSE 2400 END
    ON CONFLICT DO NOTHING`, [e.id, runId, execId, BigInt(Math.round(e.at)), BigInt(Date.now()), e.source, e.kind,
    JSON.stringify(sanitize(e.detail)) ?? null, canvasId ?? null]);
}

export async function getEvents(runId: string, after = 0) {
  const conn = await db();
  const rows = await conn.runAndReadAll(`SELECT * FROM trace_events WHERE run_id=$1 AND event_order > $2 ORDER BY at_ms, event_order`, [runId, BigInt(Math.max(0, Math.round(after))) ]);
  return rows.getRowObjects().map((r) => ({ id: String(r.id), execId: String(r.exec_id),
    at: Number(r.at_ms), receivedMs: Number(r.received_ms), order: Number(r.event_order), source: r.source as TraceEvent["source"],
    kind: String(r.kind), detail: parse(r.detail_json) }));
}

export async function markInterrupted(): Promise<void> {
  const conn = await db();
  await conn.run(`UPDATE step_runs SET status='interrupted', finished_ms=$1,
    error='Proxy restarted before execution finished; inspect the last recorded event.' WHERE status='running'`, [BigInt(Date.now())]);
  await conn.run(`UPDATE runs SET finished_ms=(SELECT max(finished_ms) FROM step_runs WHERE step_runs.run_id=runs.run_id)`);
}

export async function getRunProgress(runId: string, after = 0, canvasId = LEGACY_CANVAS_ID) {
  const conn = await db();
  const rows = await conn.runAndReadAll(`SELECT s.exec_id,s.status,s.error,s.finished_ms FROM step_runs s JOIN runs r USING(run_id) WHERE s.run_id=$1 AND r.canvas_id=$2`, [runId, canvasId]);
  if (!rows.getRowObjects().length) return { cursor: after, events: [], steps: [] };
  const events = await getEvents(runId, after);
  const cursor = Math.max(after, ...events.map((entry) => entry.order));
  return { cursor, events, steps: rows.getRowObjects().map((r) => ({ execId: String(r.exec_id),
    status: String(r.status), error: r.error as string | null, finishedMs: num(r.finished_ms) })) };
}

export type TraceArchive = { version: 1; runs: Array<{ run: Awaited<ReturnType<typeof listRuns>>[number]; steps: Awaited<ReturnType<typeof getRun>> }> };

export async function exportCanvasTraces(canvasId: string): Promise<TraceArchive> {
  const runs = await listRuns(canvasId, 10_000);
  return { version: 1, runs: await Promise.all(runs.map(async (run) => ({ run, steps: await getRun(run.runId, canvasId) }))) };
}

export async function importCanvasTraces(canvasId: string, archive: TraceArchive): Promise<void> {
  if (archive?.version !== 1 || !Array.isArray(archive.runs) || archive.runs.length > 10_000) {
    throw Object.assign(new Error("Invalid trace archive"), { status: 400 });
  }
  const steps = archive.runs.reduce((sum, item) => sum + (Array.isArray(item?.steps) ? item.steps.length : 100_001), 0);
  if (steps > 100_000) throw Object.assign(new Error("Trace archive is too large"), { status: 413 });

  const runIds = new Set<string>();
  for (const item of archive.runs) {
    if (!item?.run || typeof item.run.runId !== "string" || item.run.runId.length > 200 || runIds.has(item.run.runId) || !Array.isArray(item.steps)) {
      throw Object.assign(new Error("Invalid trace archive"), { status: 400 });
    }
    runIds.add(item.run.runId);
    for (const step of item.steps) {
      if (!step || typeof step.execId !== "string" || step.execId.length > 200 || typeof step.runId !== "string" || step.runId !== item.run.runId) {
        throw Object.assign(new Error("Invalid trace archive"), { status: 400 });
      }
    }
  }

  const conn = await db();
  for (const runId of runIds) {
    const owner = (await conn.runAndReadAll(`SELECT canvas_id FROM runs WHERE run_id=$1`, [runId])).getRowObjects()[0];
    if (owner && owner.canvas_id !== canvasId) throw Object.assign(new Error("Trace archive conflicts with another canvas"), { status: 409 });
  }

  await conn.run("BEGIN TRANSACTION");
  try {
    const oldRuns = (await conn.runAndReadAll(`SELECT run_id FROM runs WHERE canvas_id=$1`, [canvasId])).getRowObjects().map((r) => String(r.run_id));
    for (const runId of oldRuns) await deleteRun(runId, canvasId);
    for (const item of archive.runs) {
      for (const step of item.steps) {
        await recordStep({ ...step, canvasId, kind: item.run.kind, seq: step.seq ?? 0,
          startedMs: step.startedMs ?? Date.now(), status: step.status as StepTrace["status"] });
        for (const entry of Array.isArray(step.events) ? step.events : []) {
          await recordEvent(step.runId, step.execId, entry, canvasId);
        }
      }
    }
    await conn.run("COMMIT");
  } catch (err) { await conn.run("ROLLBACK"); throw err; }
}
