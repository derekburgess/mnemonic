import { mkdirSync } from "node:fs";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

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
  finishedMs: number;
  status: "ok" | "error";
  error: string | null;
  systemPrompt: string | null;
  inputPrompt: string;
  context: unknown;
  tools: unknown;
  /** Every request/response pair in the tool loop, including reasoning items verbatim. */
  rounds: unknown;
  toolCalls: unknown;
  outputText: string | null;
  usage: unknown;
};

let connection: DuckDBConnection | null = null;

/** Opened lazily so the proxy still starts if the database cannot be created. */
export async function db(): Promise<DuckDBConnection> {
  if (connection) return connection;

  mkdirSync(DB_DIR, { recursive: true });
  const instance = await DuckDBInstance.create(DB_PATH);
  const conn = await instance.connect();

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
      usage_json TEXT
    )`);

  connection = conn;
  return conn;
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
    [t.runId, t.kind, BigInt(t.startedMs), BigInt(t.finishedMs)],
  );

  await conn.run(
    `INSERT OR REPLACE INTO step_runs VALUES
     ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      t.execId, t.runId, t.seq, t.nodeId, t.label,
      t.requestedModel, t.servedModel, t.effort,
      BigInt(t.startedMs), BigInt(t.finishedMs),
      t.status, t.error,
      t.systemPrompt, t.inputPrompt,
      json(t.context), json(t.tools), json(t.rounds), json(t.toolCalls),
      t.outputText, json(t.usage),
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
            sum(CASE WHEN s.status = 'error' THEN 1 ELSE 0 END) AS errors,
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
    errors: num(r.errors) ?? 0,
    models: (r.models as string) ?? "",
  }));
}

export async function getRun(runId: string) {
  const conn = await db();
  const reader = await conn.runAndReadAll(
    `SELECT * FROM step_runs WHERE run_id = $1 ORDER BY seq, started_ms`,
    [runId],
  );
  return reader.getRowObjects().map((r) => ({
    execId: r.exec_id as string,
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
  }));
}

export async function deleteRun(runId: string): Promise<void> {
  const conn = await db();
  await conn.run(`DELETE FROM step_runs WHERE run_id = $1`, [runId]);
  await conn.run(`DELETE FROM runs WHERE run_id = $1`, [runId]);
}
