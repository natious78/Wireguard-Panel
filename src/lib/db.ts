import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "./env";

declare global {
  var __wgPool: Pool | undefined;
}

export const pool =
  global.__wgPool ??
  new Pool({
    ...(env().DATABASE_URL
      ? { connectionString: env().DATABASE_URL }
      : {
          host: env().DB_HOST,
          port: env().DB_PORT,
          database: env().DB_NAME,
          user: env().DB_USER,
          password: env().DB_PASSWORD,
        }),
    max: 15,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "wireguard-control",
  });

if (env().NODE_ENV !== "production") global.__wgPool = pool;

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  return pool.query<T>(text, values);
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
