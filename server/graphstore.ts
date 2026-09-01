import { db } from "./trace.js";

/** There is exactly one graph, the way localStorage held exactly one. */
const ROW = "current";

export type StoredGraph = { nodes: unknown[]; edges: unknown[]; updatedMs: number };

export async function loadGraph(): Promise<StoredGraph | null> {
  const conn = await db();
  const reader = await conn.runAndReadAll(
    `SELECT nodes_json, edges_json, updated_ms FROM graph WHERE id = $1`,
    [ROW],
  );
  const row = reader.getRowObjects()[0];
  if (!row) return null;

  try {
    return {
      nodes: JSON.parse(row.nodes_json as string),
      edges: JSON.parse(row.edges_json as string),
      updatedMs: Number(row.updated_ms),
    };
  } catch {
    // A corrupt row should read as "nothing saved" rather than taking the app down.
    return null;
  }
}

export async function saveGraph(nodes: unknown[], edges: unknown[]): Promise<number> {
  const conn = await db();
  const updatedMs = Date.now();
  await conn.run(
    `INSERT OR REPLACE INTO graph (id, nodes_json, edges_json, updated_ms) VALUES ($1, $2, $3, $4)`,
    [ROW, JSON.stringify(nodes), JSON.stringify(edges), BigInt(updatedMs)],
  );
  return updatedMs;
}
