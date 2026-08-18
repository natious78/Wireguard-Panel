import { pool } from "../src/lib/db";
import { env } from "../src/lib/env";
import { hashPassword } from "../src/lib/security";

async function initAdmin() {
  const config = env();
  if (!config.ADMIN_USERNAME || !config.ADMIN_PASSWORD) {
    process.stdout.write("ADMIN_USERNAME/ADMIN_PASSWORD not set; administrator initialization skipped.\n");
    return;
  }
  const existing = await pool.query("SELECT 1 FROM users LIMIT 1");
  if (existing.rowCount) {
    process.stdout.write("A user already exists; initialization variables were ignored.\n");
    return;
  }
  const passwordHash = await hashPassword(config.ADMIN_PASSWORD);
  await pool.query("INSERT INTO users(username, password_hash, role) VALUES ($1,$2,'admin')", [
    config.ADMIN_USERNAME,
    passwordHash,
  ]);
  process.stdout.write(`Administrator '${config.ADMIN_USERNAME}' created.\n`);
}

initAdmin()
  .then(() => pool.end())
  .catch((error) => {
    process.stderr.write(`Administrator initialization failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
