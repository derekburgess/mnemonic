import { openDatabase, migrateDatabase } from "./storage.js";
import path from "node:path";
import { type DuckDBConnection } from "@duckdb/node-api";
import { sanitize, deliveryState, type TraceEvent } from "./events.js";
import type { ContainerTrace } from "./containerTrace.js";

const DB_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "mnemonic.duckdb");

/** One execution of one step, captured in full. */
export type StepTrace = {
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
    await migrateDatabase(conn, DB_PATH, 1, async () => {
      await conn.run(`
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          kind TEXT,
          started_ms BIGINT,
          finished_ms BIGINT
        )`);
      await conn.run(`
        CREATE TABLE IF NOT EXISTS step_runs (
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
          links_json TEXT
        )`);

      // Databases created before these columns existed are brought up to date in place.
      for (const column of ["params_json", "files_json", "links_json", "container_json"]) {
        await conn.run(`ALTER TABLE step_runs ADD COLUMN IF NOT EXISTS ${column} TEXT`);
      }

      await conn.run(`CREATE TABLE IF NOT EXISTS trace_events (
        id TEXT PRIMARY KEY, run_id TEXT, exec_id TEXT, at_ms BIGINT, received_ms BIGINT,
        source TEXT, kind TEXT, detail_json TEXT)`);
      await conn.run(`CREATE SEQUENCE IF NOT EXISTS trace_event_order START 1`);
      await conn.run(`ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS event_order BIGINT`);
      await conn.run(`UPDATE trace_events SET event_order=nextval('trace_event_order') WHERE event_order IS NULL`);
      await conn.run(`CREATE INDEX IF NOT EXISTS trace_events_step ON trace_events(run_id, exec_id)`);

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
    `INSERT INTO runs (run_id, kind, started_ms, finished_ms) VALUES ($1, $2, $3, $4)
     ON CONFLICT (run_id) DO UPDATE SET
       finished_ms = greatest(runs.finished_ms, excluded.finished_ms),
       started_ms = least(runs.started_ms, excluded.started_ms)`,
    [t.runId, t.kind, BigInt(t.startedMs), t.finishedMs === null ? null : BigInt(t.finishedMs)],
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

export async function listRuns(limit = 100) {
  const conn = await db();
  const reader = await conn.runAndReadAll(
    `SELECT r.run_id, r.kind, r.started_ms, r.finished_ms,
            count(s.exec_id) AS steps,
            sum(CASE WHEN s.status = 'running' THEN 1 ELSE 0 END) AS running,
            sum(CASE WHEN s.status IN ('error', 'interrupted') THEN 1 ELSE 0 END) AS errors,
            string_agg(DISTINCT s.requested_model, ', ') AS models
     FROM runs r LEFT JOIN step_runs s USING (run_id)
     GROUP BY ALL ORDER BY r.started_ms DESC LIMIT $1`,
    [limit],
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

export async function getRun(runId: string) {
  const conn = await db();
  const reader = await conn.runAndReadAll(
    `SELECT * FROM step_runs WHERE run_id = $1 ORDER BY seq, started_ms`,
    [runId],
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

export async function deleteRun(runId: string): Promise<void> {
  const conn = await db();
  await conn.run(`DELETE FROM trace_events WHERE run_id = $1`, [runId]);
  await conn.run(`DELETE FROM step_runs WHERE run_id = $1`, [runId]);
  await conn.run(`DELETE FROM runs WHERE run_id = $1`, [runId]);
}

/** Events are independent writes, so progress survives a lost final response or proxy crash. */
export async function recordEvent(runId: string, execId: string, e: TraceEvent): Promise<void> {
  const conn = await db();
  await conn.run(`INSERT INTO trace_events (id,run_id,exec_id,at_ms,received_ms,source,kind,detail_json,event_order)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,nextval('trace_event_order')
    WHERE (SELECT count(*) FROM trace_events WHERE run_id=$2 AND exec_id=$3) < CASE WHEN $7 IN ('graph.committed','graph.failed','execution.completed','execution.failed','result.saved','delivery.received','delivery.recovered') THEN 2500 ELSE 2400 END
    ON CONFLICT DO NOTHING`, [e.id, runId, execId, BigInt(Math.round(e.at)), BigInt(Date.now()), e.source, e.kind,
    JSON.stringify(sanitize(e.detail)) ?? null]);
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

export async function getRunProgress(runId: string, after = 0) {
  const conn = await db();
  const rows = await conn.runAndReadAll(`SELECT exec_id,status,error,finished_ms FROM step_runs WHERE run_id=$1`, [runId]);
  const events = await getEvents(runId, after);
  const cursor = Math.max(after, ...events.map((entry) => entry.order));
  return { cursor, events, steps: rows.getRowObjects().map((r) => ({ execId: String(r.exec_id),
    status: String(r.status), error: r.error as string | null, finishedMs: num(r.finished_ms) })) };
}
