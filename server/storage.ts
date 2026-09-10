import { copyFile, mkdir, mkdtemp, chmod } from "node:fs/promises";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

export async function backupDatabase(file: string): Promise<void> {
  const root = path.join(path.dirname(file), "backups");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const backup = await mkdtemp(path.join(root, path.basename(file) + "-"));
  await chmod(backup, 0o700);
  for (const suffix of ["", ".wal"]) {
    try {
      const target = path.join(backup, path.basename(file) + suffix);
      await copyFile(file + suffix, target);
      await chmod(target, 0o600);
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
}

export async function openDatabase(file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    // Initialize a default catalog before replaying older function-default WAL entries.
    await conn.run(`ATTACH '${file.replaceAll("'", "''")}' AS store`);
    await conn.run("USE store");
    return { conn, close: () => { conn.closeSync(); instance.closeSync(); } };
  } catch (err) { conn.closeSync(); instance.closeSync(); throw err; }
}

export async function migrateDatabase(conn: DuckDBConnection, file: string, version: number, apply: () => Promise<void>) {
  const tables = await conn.runAndReadAll("SELECT table_name FROM information_schema.tables WHERE table_name='schema_version'");
  const current = tables.getRowObjects().length
    ? Number((await conn.runAndReadAll("SELECT max(version) AS version FROM schema_version")).getRowObjects()[0].version ?? 0) : 0;
  if (current > version) throw new Error(`Database schema ${current} is newer than this app supports (${version}).`);
  if (current === version) return;
  await backupDatabase(file);
  await conn.run("BEGIN TRANSACTION");
  try {
    await apply();
    await conn.run("CREATE TABLE IF NOT EXISTS schema_version(version INTEGER)");
    await conn.run("DELETE FROM schema_version");
    await conn.run("INSERT INTO schema_version VALUES ($1)", [version]);
    await conn.run("COMMIT");
  } catch (err) { await conn.run("ROLLBACK"); throw err; }
  await conn.run("CHECKPOINT");
}
