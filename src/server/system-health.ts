import { statfs } from "node:fs/promises";
import { env } from "@/lib/env";
import { query } from "@/lib/db";

export type SystemHealth = {
  databaseBytes: number;
  trafficSnapshotBytes: number;
  auditBytes: number;
  processRssBytes: number;
  processHeapBytes: number;
  storagePath: string;
  storageTotalBytes: number | null;
  storageAvailableBytes: number | null;
  storageUsedPercent: number | null;
  storageLevel: "ok" | "warning" | "critical" | "unknown";
  logMode: "stdout";
  workerJobs: number;
  workerFailures: number;
  workerLastUpdate: string | null;
};

export async function getSystemHealth(): Promise<SystemHealth> {
  const [sizes,worker,storage]=await Promise.all([
    query<{database_bytes:string;traffic_bytes:string;audit_bytes:string}>(`SELECT pg_database_size(current_database())::text database_bytes,
      pg_total_relation_size('traffic_snapshots')::text traffic_bytes,pg_total_relation_size('audit_logs')::text audit_bytes`),
    query<{jobs:string;failures:string;latest:Date|null}>("SELECT count(*)::text jobs,count(*) FILTER(WHERE status='failed')::text failures,max(updated_at) latest FROM worker_job_health"),
    filesystemStats(),
  ]);
  const size=sizes.rows[0];const jobs=worker.rows[0];const memory=process.memoryUsage();
  const usedPercent=storage.total>0?Math.round(((storage.total-storage.available)/storage.total)*1000)/10:null;
  const runtime=env();
  return{
    databaseBytes:Number(size?.database_bytes??0),trafficSnapshotBytes:Number(size?.traffic_bytes??0),auditBytes:Number(size?.audit_bytes??0),
    processRssBytes:memory.rss,processHeapBytes:memory.heapUsed,storagePath:storage.path,storageTotalBytes:storage.total||null,
    storageAvailableBytes:storage.total?storage.available:null,storageUsedPercent:usedPercent,
    storageLevel:usedPercent===null?"unknown":usedPercent>=runtime.STORAGE_CRITICAL_PERCENT?"critical":usedPercent>=runtime.STORAGE_WARNING_PERCENT?"warning":"ok",
    logMode:"stdout",workerJobs:Number(jobs?.jobs??0),workerFailures:Number(jobs?.failures??0),workerLastUpdate:jobs?.latest?new Date(jobs.latest).toISOString():null,
  };
}

async function filesystemStats(){
  const preferred=env().PERSISTENT_DATA_PATH;
  for(const path of [preferred,process.cwd()]){
    try{const value=await statfs(path,{bigint:true});return{path,total:Number(value.blocks*value.bsize),available:Number(value.bavail*value.bsize)}}catch{}
  }
  return{path:preferred,total:0,available:0};
}
