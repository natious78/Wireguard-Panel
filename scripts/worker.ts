import { pool, query } from "../src/lib/db";
import { env } from "../src/lib/env";
import { enforceExpirations } from "../src/server/expiration";
import { syncRouter } from "../src/server/sync";
import { pollAllRouterTraffic } from "../src/server/traffic-accounting";
import { backfillPeerQrs } from "../src/server/qr-service";

let stopping = false;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function syncCycle() {
  const routers = await query<{ id: string; name: string }>("SELECT id,name FROM routers WHERE enabled=true ORDER BY name");
  for (const router of routers.rows) {
    if (stopping) break;
    try { await syncRouter(router.id); }
    catch (error) { process.stderr.write(`Sync failed for ${router.name}: ${error instanceof Error ? error.message : "unknown error"}\n`); }
  }
}

async function main() {
  process.stdout.write("WireGuard Control worker started.\n");
  let lastSync = 0;
  let lastStats = 0;
  let lastExpiration = 0;
  let lastMaintenance = 0;
  while (!stopping) {
    const now = Date.now();
    if (now - lastSync >= env().SYNC_INTERVAL_SECONDS * 1000) {
      await syncCycle();
      lastSync = Date.now();
    }
    if (now - lastStats >= env().MIKROTIK_STATS_INTERVAL * 1000) {
      await pollAllRouterTraffic();
      lastStats = Date.now();
    }
    if (now - lastExpiration >= env().EXPIRATION_INTERVAL_SECONDS * 1000) {
      await enforceExpirations();
      lastExpiration = Date.now();
    }
    if (now - lastMaintenance >= 60_000) {
      await query("DELETE FROM sessions WHERE expires_at < now() - interval '1 day'");
      await query("DELETE FROM login_attempts WHERE updated_at < now() - interval '1 day'");
      await backfillPeerQrs();
      lastMaintenance = Date.now();
    }
    await wait(Math.min(5_000, env().MIKROTIK_STATS_INTERVAL * 1000));
  }
  await pool.end();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopping = true; });
main().catch((error) => { process.stderr.write(`Worker stopped: ${error instanceof Error ? error.message : "unknown error"}\n`); process.exit(1); });
