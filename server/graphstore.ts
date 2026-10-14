import { access } from "node:fs/promises";
import path from "node:path";
import { backupDatabase, migrateDatabase, openDatabase } from "./storage.js";
import { LEGACY_CANVAS_ID } from "../src/canvasIdentity.js";

const FILE = path.resolve("data/graph.duckdb");
const LEGACY = path.resolve("data/mnemonic.duckdb");
export type StoredGraph = { canvasId: string; nodes: unknown[]; edges: unknown[]; updatedMs: number };
let opening: ReturnType<typeof initialize> | undefined;

async function initialize() {
  const database = await openDatabase(FILE);
  const { conn } = database;
  try {
    await migrateDatabase(conn, FILE, 2, async () => {
      await conn.run("CREATE TABLE IF NOT EXISTS graph(id TEXT PRIMARY KEY,nodes_json TEXT,edges_json TEXT,updated_ms BIGINT,canvas_id TEXT)");
      await conn.run("ALTER TABLE graph ADD COLUMN IF NOT EXISTS canvas_id TEXT");
      let exists = true;
      try { await access(LEGACY); } catch { exists = false; }
      const currentRows = (await conn.runAndReadAll("SELECT count(*) AS n FROM graph")).getRowObjects();
      if (exists && Number(currentRows[0]?.n ?? 0) === 0) {
        await backupDatabase(LEGACY);
        const legacy = await openDatabase(LEGACY);
        try {
          const tables = await legacy.conn.runAndReadAll("SELECT table_name FROM information_schema.tables WHERE table_name='graph'");
          if (tables.getRowObjects().length) {
            const row = (await legacy.conn.runAndReadAll("SELECT * FROM graph WHERE id='current'")).getRowObjects()[0];
            if (row) await conn.run("INSERT INTO graph (id,nodes_json,edges_json,updated_ms,canvas_id) VALUES ('current',$1,$2,$3,$4)", [row.nodes_json as string, row.edges_json as string, row.updated_ms as bigint, LEGACY_CANVAS_ID]);
          }
        } finally { legacy.close(); }
      }
      await conn.run("UPDATE graph SET canvas_id=$1 WHERE canvas_id IS NULL OR canvas_id=''", [LEGACY_CANVAS_ID]);
    });
    return database;
  } catch (err) { database.close(); throw err; }
}

export const graphDb = () => opening ??= initialize().catch((err) => { opening = undefined; throw err; });

export async function loadGraph(): Promise<StoredGraph | null> {
  const { conn } = await graphDb();
  const row = (await conn.runAndReadAll("SELECT * FROM graph WHERE id='current'")).getRowObjects()[0];
  if (!row) return null;
  return { canvasId: (row.canvas_id as string) || LEGACY_CANVAS_ID, nodes: JSON.parse(row.nodes_json as string), edges: JSON.parse(row.edges_json as string), updatedMs: Number(row.updated_ms) };
}

let writing: Promise<unknown> = Promise.resolve();
export function saveGraph(nodes: unknown[], edges: unknown[], expectedRevision?: number | null): Promise<number>;
export function saveGraph(canvasId: string, nodes: unknown[], edges: unknown[], expectedRevision?: number | null): Promise<number>;
export function saveGraph(canvasIdOrNodes: string | unknown[], nodesOrEdges: unknown[], edgesOrRevision?: unknown[] | number | null, revision?: number | null): Promise<number> {
  const legacyCall = Array.isArray(canvasIdOrNodes);
  const canvasId = legacyCall ? LEGACY_CANVAS_ID : canvasIdOrNodes;
  const nodes = legacyCall ? canvasIdOrNodes : nodesOrEdges;
  const edges = legacyCall ? nodesOrEdges : edgesOrRevision as unknown[];
  const expectedRevision = legacyCall ? edgesOrRevision as number | null | undefined : revision;
  const write = writing.catch(() => {}).then(async () => {
    const { conn } = await graphDb();
    const current = await loadGraph();
    if (expectedRevision !== undefined && expectedRevision !== (current?.updatedMs ?? null)) {
      throw Object.assign(new Error("A newer graph was saved elsewhere. Your local changes are preserved; choose which version to keep."), { status: 409 });
    }
    const updatedMs = Math.max(Date.now(), (current?.updatedMs ?? 0) + 1);
    await conn.run("INSERT OR REPLACE INTO graph (id,nodes_json,edges_json,updated_ms,canvas_id) VALUES ('current',$1,$2,$3,$4)", [JSON.stringify(nodes), JSON.stringify(edges), BigInt(updatedMs), canvasId]);
    return updatedMs;
  });
  writing = write;
  return write;
}
