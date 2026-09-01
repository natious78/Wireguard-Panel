import { pool, query } from "../src/lib/db";
import { env } from "../src/lib/env";
import { log, logFault, logRecovery, setLogLevel } from "../src/lib/logger";
import { redactError } from "../src/lib/security";
import { enforceExpirations } from "../src/server/expiration";
import { syncRouter } from "../src/server/sync";
import { pollAllRouterTraffic } from "../src/server/traffic-accounting";
import { updateWorkerHealth } from "../src/server/operations";
import { observeAllBandwidth } from "../src/server/bandwidth-service";
import { reconcilePendingOperations } from "../src/server/operation-reconciler";
import { pollAllRouterHealth } from "../src/server/router-health";
import { aggregateAndRetainTraffic } from "../src/server/traffic-retention";
import { getPerformancePolicy, type PerformancePolicy } from "../src/server/settings";

let stopping = false;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function syncCycle() {
  const routers = await query<{ id: string; name: string }>("SELECT id,name FROM routers WHERE enabled=true AND (next_retry_at IS NULL OR next_retry_at<=now()) ORDER BY name");
  const results: PromiseSettledResult<unknown>[] = [];
  for (const router of routers.rows) {
    try {
      results.push({ status: "fulfilled", value: await syncRouter(router.id) });
      logRecovery(`router-sync:${router.id}`, "Router synchronization recovered", { router: router.name });
    } catch (error) {
      const signature = redactError(error);
      results.push({ status: "rejected", reason: error });
      logFault(`router-sync:${router.id}`, signature, "Router synchronization failed", { router: router.name, error: signature });
    }
  }
  return {routers:routers.rows.length,succeeded:results.filter((result)=>result.status==="fulfilled").length,failed:results.filter((result)=>result.status==="rejected").length};
}

async function maintenanceCycle(policy: PerformancePolicy){
  const [sessions,attempts,auditLogs]=await Promise.all([
    query("DELETE FROM sessions WHERE expires_at < now() - interval '1 day'"),
    query("DELETE FROM login_attempts WHERE updated_at < now() - interval '1 day'"),
    policy.auditRetentionDays === 0
      ? Promise.resolve({ rowCount: 0 })
      : query("DELETE FROM audit_logs WHERE created_at < now()-($1::text||' days')::interval", [policy.auditRetentionDays]),
  ]);
  return{sessionsDeleted:sessions.rowCount??0,attemptsDeleted:attempts.rowCount??0,auditLogsDeleted:auditLogs.rowCount??0};
}

type Job={name:string;intervalMs:()=>number;nextAt:number;run:()=>Promise<unknown>};
const active=new Map<string,Promise<void>>();

async function runTracked(job:Job){
  const startedAt=new Date();const started=Date.now();
  await updateWorkerHealth(job.name,{status:"running",startedAt,nextRunAt:new Date(job.nextAt)}).catch(()=>undefined);
  try{
    const result=await job.run();const durationMs=Date.now()-started;
    const details=safeDetails(result);const failures=typeof details.failed==="number"?details.failed:0;
    if(failures>0){
      logFault(`job:${job.name}`, `${failures}`, "Background job completed with failures", { job: job.name, failures, details });
      await updateWorkerHealth(job.name,{status:"degraded",error:new Error(`${failures} operation${failures===1?"":"s"} failed.`),durationMs,nextRunAt:new Date(job.nextAt),details});
    }else{
      logRecovery(`job:${job.name}`, "Background job recovered", { job: job.name });
      await updateWorkerHealth(job.name,{status:"healthy",success:true,durationMs,nextRunAt:new Date(job.nextAt),details});
    }
  }catch(error){
    const durationMs=Date.now()-started;const signature=redactError(error);
    logFault(`job:${job.name}`, signature, "Background job failed", { job: job.name, error: signature });
    await updateWorkerHealth(job.name,{status:"failed",error,durationMs,nextRunAt:new Date(job.nextAt)}).catch(()=>undefined);
  }
}

function launch(job:Job,now:number){
  if(stopping||now<job.nextAt||active.has(job.name))return;
  job.nextAt=now+job.intervalMs();
  const promise=runTracked(job).finally(()=>active.delete(job.name));
  active.set(job.name,promise);
}

async function main() {
  let performance = await getPerformancePolicy();
  setLogLevel(performance.logLevel);
  log("info", "WireGuard Control worker started", { trafficPollSeconds: performance.trafficPollSeconds, syncIntervalSeconds: performance.syncIntervalSeconds });
  const now=Date.now();
  const jobs:Job[]=[
    {name:"performance_refresh",intervalMs:()=>60_000,nextAt:now+60_000,run:async()=>{performance=await getPerformancePolicy();setLogLevel(performance.logLevel);return{loaded:true}}},
    {name:"router_health",intervalMs:()=>performance.routerHealthSeconds*1000,nextAt:now,run:pollAllRouterHealth},
    {name:"router_sync",intervalMs:()=>performance.syncIntervalSeconds*1000,nextAt:now+2_000,run:syncCycle},
    {name:"traffic_poll",intervalMs:()=>performance.trafficPollSeconds*1000,nextAt:now+4_000,run:pollAllRouterTraffic},
    {name:"expiration_enforcement",intervalMs:()=>env().EXPIRATION_INTERVAL_SECONDS*1000,nextAt:now+6_000,run:enforceExpirations},
    {name:"bandwidth_observation",intervalMs:()=>performance.bandwidthSeconds*1000,nextAt:now+8_000,run:observeAllBandwidth},
    {name:"operation_reconciliation",intervalMs:()=>performance.operationReconciliationSeconds*1000,nextAt:now+10_000,run:reconcilePendingOperations},
    {name:"traffic_retention",intervalMs:()=>performance.trafficAggregationSeconds*1000,nextAt:now+12_000,run:aggregateAndRetainTraffic},
    {name:"maintenance",intervalMs:()=>performance.maintenanceSeconds*1000,nextAt:now+14_000,run:()=>maintenanceCycle(performance)},
  ];
  while(!stopping){const tick=Date.now();for(const job of jobs)launch(job,tick);await wait(1_000)}
  await Promise.allSettled([...active.values()]);
  await pool.end();
  log("info", "WireGuard Control worker stopped");
}

function safeDetails(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=="object")return{result:value??null};
  return JSON.parse(JSON.stringify(value,(_key,item)=>typeof item==="bigint"?item.toString():item)) as Record<string,unknown>;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { if (!stopping) log("info", "Worker shutdown requested", { signal }); stopping = true; });
main().catch((error) => { log("error", "Worker stopped unexpectedly", { error: redactError(error) }); process.exit(1); });
