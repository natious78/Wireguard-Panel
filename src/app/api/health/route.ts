import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { env } from "@/lib/env";

export async function GET() {
  const started = Date.now();
  try {
    const [scheduler,databaseSize]=await Promise.all([
      pool.query<{latest:Date|null;failed:string;jobs:string}>("SELECT max(updated_at) latest,count(*) FILTER(WHERE status='failed')::text failed,count(*)::text jobs FROM worker_job_health"),
      pool.query<{bytes:string}>("SELECT pg_database_size(current_database())::text bytes"),
    ]);
    const row=scheduler.rows[0];const latest=row?.latest?new Date(row.latest):null;
    const stale=process.uptime()>120&&(!latest||Date.now()-latest.getTime()>env().HEALTH_WORKER_STALE_SECONDS*1000);
    const failed=Number(row?.failed??0);
    const healthy=!stale&&failed===0;
    const memory=process.memoryUsage();
    return NextResponse.json({
      status:healthy?"healthy":"degraded",application:"ok",database:"ok",
      scheduler:{status:stale?"stale":failed?"failed":"ok",jobs:Number(row?.jobs??0),lastUpdate:latest?.toISOString()??null},
      process:{rssBytes:memory.rss,heapUsedBytes:memory.heapUsed},databaseBytes:Number(databaseSize.rows[0]?.bytes??0),latencyMs:Date.now()-started,
    }, { status:healthy?200:503,headers:{"Cache-Control":"no-store"} });
  } catch {
    return NextResponse.json({ status: "unhealthy", application: "ok", database: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
