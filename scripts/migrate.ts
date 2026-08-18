import fs from "node:fs/promises";
import path from "node:path";
import { pool } from "../src/lib/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(20402040)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const directory = path.join(process.cwd(), "migrations");
    const files = (await fs.readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
      if (applied.rowCount) continue;
      const sql = await fs.readFile(path.join(directory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        process.stdout.write(`Applied migration ${file}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(20402040)").catch(() => undefined);
    client.release();
  }
}

migrate()
  .then(() => pool.end())
  .catch((error) => {
    process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
