import { access } from "node:fs/promises";
import path from "node:path";
import { backupDatabase, migrateDatabase, openDatabase } from "./storage.js";

const FILE = path.resolve("data/graph.duckdb");
const LEGACY = path.resolve("data/mnemonic.duckdb");
export type StoredGraph = { nodes: unknown[]; edges: unknown[]; updatedMs: number };
let opening: ReturnType<typeof initialize> | undefined;

async function initialize() {
  const database = await openDatabase(FILE);
  const { conn } = database;
  try {
    await migrateDatabase(conn, FILE, 1, async () => {
      await conn.run("CREATE TABLE graph(id TEXT PRIMARY KEY,nodes_json TEXT,edges_json TEXT,updated_ms BIGINT)");
      let exists = true;
      try { await access(LEGACY); } catch { exists = false; }
      if (exists) {
        await backupDatabase(LEGACY);
        const legacy = await openDatabase(LEGACY);
        try {
          const tables = await legacy.conn.runAndReadAll("SELECT table_name FROM information_schema.tables WHERE table_name='graph'");
          if (tables.getRowObjects().length) {
            const row = (await legacy.conn.runAndReadAll("SELECT * FROM graph WHERE id='current'")).getRowObjects()[0];
            if (row) await conn.run("INSERT INTO graph VALUES ('current',$1,$2,$3)", [row.nodes_json as string, row.edges_json as string, row.updated_ms as bigint]);
          }
        } finally { legacy.close(); }
      }
    });
    return database;
  } catch (err) { database.close(); throw err; }
}

export const graphDb = () => opening ??= initialize().catch((err) => { opening = undefined; throw err; });

export async function loadGraph(): Promise<StoredGraph | null> {
  const { conn } = await graphDb();
  const row = (await conn.runAndReadAll("SELECT * FROM graph WHERE id='current'")).getRowObjects()[0];
  if (!row) return null;
  return { nodes: JSON.parse(row.nodes_json as string), edges: JSON.parse(row.edges_json as string), updatedMs: Number(row.updated_ms) };
}

let writing: Promise<unknown> = Promise.resolve();
export function saveGraph(nodes: unknown[], edges: unknown[], expectedRevision?: number | null): Promise<number> {
  const write = writing.catch(() => {}).then(async () => {
    const { conn } = await graphDb();
    const current = await loadGraph();
    if (expectedRevision !== undefined && expectedRevision !== (current?.updatedMs ?? null)) {
      throw Object.assign(new Error("A newer graph was saved elsewhere. Your local changes are preserved; choose which version to keep."), { status: 409 });
    }
    const updatedMs = Math.max(Date.now(), (current?.updatedMs ?? 0) + 1);
    await conn.run("INSERT OR REPLACE INTO graph VALUES ('current',$1,$2,$3)", [JSON.stringify(nodes), JSON.stringify(edges), BigInt(updatedMs)]);
    return updatedMs;
  });
  writing = write;
  return write;
}
