import { pool, query } from "../src/lib/db";
import { env } from "../src/lib/env";
import { redactError } from "../src/lib/security";
import { enforceExpirations } from "../src/server/expiration";
import { syncRouter } from "../src/server/sync";
import { pollAllRouterTraffic } from "../src/server/traffic-accounting";
import { backfillPeerQrs } from "../src/server/qr-service";
import { updateWorkerHealth } from "../src/server/operations";
import { observeAllBandwidth } from "../src/server/bandwidth-service";
import { reconcilePendingOperations } from "../src/server/operation-reconciler";
import { pollAllRouterHealth } from "../src/server/router-health";
import { aggregateAndRetainTraffic } from "../src/server/traffic-retention";

let stopping = false;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function syncCycle() {
  const routers = await query<{ id: string; name: string }>("SELECT id,name FROM routers WHERE enabled=true AND (next_retry_at IS NULL OR next_retry_at<=now()) ORDER BY name");
  const results = await Promise.allSettled(routers.rows.map((router) => syncRouter(router.id)));
  results.forEach((result,index)=>{if(result.status==="rejected")process.stderr.write(`Sync failed for ${routers.rows[index].name}: ${redactError(result.reason)}\n`)});
  return {routers:routers.rows.length,succeeded:results.filter((result)=>result.status==="fulfilled").length,failed:results.filter((result)=>result.status==="rejected").length};
}

async function maintenanceCycle(){
  const [sessions,attempts,qr]=await Promise.all([
    query("DELETE FROM sessions WHERE expires_at < now() - interval '1 day'"),
    query("DELETE FROM login_attempts WHERE updated_at < now() - interval '1 day'"),
    backfillPeerQrs(),
  ]);
  return{sessionsDeleted:sessions.rowCount??0,attemptsDeleted:attempts.rowCount??0,qr};
}

type Job={name:string;intervalMs:number;nextAt:number;run:()=>Promise<unknown>};
const active=new Map<string,Promise<void>>();

async function runTracked(job:Job){
  const startedAt=new Date();const started=Date.now();
  await updateWorkerHealth(job.name,{status:"running",startedAt,nextRunAt:new Date(job.nextAt)}).catch(()=>undefined);
  try{
    const result=await job.run();const durationMs=Date.now()-started;
    await updateWorkerHealth(job.name,{status:"healthy",success:true,durationMs,nextRunAt:new Date(job.nextAt),details:safeDetails(result)});
  }catch(error){
    const durationMs=Date.now()-started;process.stderr.write(`${job.name} failed: ${redactError(error)}\n`);
    await updateWorkerHealth(job.name,{status:"failed",error,durationMs,nextRunAt:new Date(job.nextAt)}).catch(()=>undefined);
  }
}

function launch(job:Job,now:number){
  if(stopping||now<job.nextAt||active.has(job.name))return;
  job.nextAt=now+job.intervalMs;
  const promise=runTracked(job).finally(()=>active.delete(job.name));
  active.set(job.name,promise);
}

async function main() {
  process.stdout.write("WireGuard Control worker started.\n");
  const now=Date.now();
  const jobs:Job[]=[
    {name:"router_health",intervalMs:60_000,nextAt:now,run:pollAllRouterHealth},
    {name:"router_sync",intervalMs:env().SYNC_INTERVAL_SECONDS*1000,nextAt:now+2_000,run:syncCycle},
    {name:"traffic_poll",intervalMs:env().MIKROTIK_STATS_INTERVAL*1000,nextAt:now+4_000,run:pollAllRouterTraffic},
    {name:"expiration_enforcement",intervalMs:env().EXPIRATION_INTERVAL_SECONDS*1000,nextAt:now+6_000,run:enforceExpirations},
    {name:"bandwidth_observation",intervalMs:60_000,nextAt:now+8_000,run:observeAllBandwidth},
    {name:"operation_reconciliation",intervalMs:30_000,nextAt:now+10_000,run:reconcilePendingOperations},
    {name:"traffic_retention",intervalMs:300_000,nextAt:now+12_000,run:aggregateAndRetainTraffic},
    {name:"maintenance",intervalMs:60_000,nextAt:now+14_000,run:maintenanceCycle},
  ];
  while(!stopping){const tick=Date.now();for(const job of jobs)launch(job,tick);await wait(1_000)}
  await Promise.allSettled([...active.values()]);
  await pool.end();
}

function safeDetails(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=="object")return{result:value??null};
  return JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==="bigint"?item.toString():item)) as Record<string,unknown>;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopping = true; });
main().catch((error) => { process.stderr.write(`Worker stopped: ${redactError(error)}\n`); process.exit(1); });
