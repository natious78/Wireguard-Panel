import { query } from "@/lib/db";
import { env } from "@/lib/env";
import type { QuotaPolicy } from "./quota";

export type StatusThresholds={onlineSeconds:number;recentSeconds:number};
export async function getStatusThresholds():Promise<StatusThresholds>{
 try{const result=await query<{value:StatusThresholds}>("SELECT value FROM settings WHERE key='status_thresholds'");const value=result.rows[0]?.value;return value&&value.onlineSeconds>0&&value.recentSeconds>value.onlineSeconds?value:{onlineSeconds:env().ONLINE_THRESHOLD_SECONDS,recentSeconds:env().RECENT_THRESHOLD_SECONDS}}catch{return{onlineSeconds:env().ONLINE_THRESHOLD_SECONDS,recentSeconds:env().RECENT_THRESHOLD_SECONDS}}
}

const DEFAULT_QUOTA_POLICY: QuotaPolicy = { timezone: "UTC", weekStartsOn: 1, monthlyResetDay: 1 };
export async function getQuotaPolicy(): Promise<QuotaPolicy> {
  try {
    const result = await query<{ value: QuotaPolicy }>("SELECT value FROM settings WHERE key='quota_policy'");
    const value = result.rows[0]?.value;
    return value && typeof value.timezone === "string" && Number.isInteger(value.weekStartsOn) && Number.isInteger(value.monthlyResetDay)
      ? value
      : DEFAULT_QUOTA_POLICY;
  } catch { return DEFAULT_QUOTA_POLICY; }
}

export type GlobalBandwidthDefaults={mode:"unlimited"|"custom";downloadBps:string|null;uploadBps:string|null};
export async function getGlobalBandwidthDefaults():Promise<GlobalBandwidthDefaults>{
  try{const result=await query<{value:GlobalBandwidthDefaults}>("SELECT value FROM settings WHERE key='bandwidth_defaults'");const value=result.rows[0]?.value;
    return value?.mode==="custom"&&value.downloadBps&&value.uploadBps?value:{mode:"unlimited",downloadBps:null,uploadBps:null};
  }catch{return{mode:"unlimited",downloadBps:null,uploadBps:null}}
}

export type PerformancePolicy = {
  trafficPollSeconds: number;
  syncIntervalSeconds: number;
  routerHealthSeconds: number;
  bandwidthSeconds: number;
  operationReconciliationSeconds: number;
  trafficAggregationSeconds: number;
  maintenanceSeconds: number;
  rawTrafficSampleSeconds: number;
  auditRetentionDays: number;
  logLevel: "error" | "warn" | "info" | "debug";
};

export function defaultPerformancePolicy(): PerformancePolicy {
  const runtime = env();
  return {
    trafficPollSeconds: runtime.MIKROTIK_STATS_INTERVAL,
    syncIntervalSeconds: runtime.SYNC_INTERVAL_SECONDS,
    routerHealthSeconds: runtime.ROUTER_HEALTH_INTERVAL_SECONDS,
    bandwidthSeconds: runtime.BANDWIDTH_INTERVAL_SECONDS,
    operationReconciliationSeconds: runtime.OPERATION_RECONCILIATION_INTERVAL_SECONDS,
    trafficAggregationSeconds: runtime.TRAFFIC_AGGREGATION_INTERVAL_SECONDS,
    maintenanceSeconds: runtime.MAINTENANCE_INTERVAL_SECONDS,
    rawTrafficSampleSeconds: runtime.RAW_TRAFFIC_SAMPLE_SECONDS,
    auditRetentionDays: runtime.AUDIT_RETENTION_DAYS,
    logLevel: runtime.LOG_LEVEL,
  };
}

export async function getPerformancePolicy(): Promise<PerformancePolicy> {
  const fallback = defaultPerformancePolicy();
  try {
    const value = (await query<{ value: Partial<PerformancePolicy> }>("SELECT value FROM settings WHERE key='performance_policy'")).rows[0]?.value;
    if (!value) return fallback;
    const candidate = { ...fallback, ...value };
    return validPerformancePolicy(candidate) ? candidate : fallback;
  } catch {
    return fallback;
  }
}

export function validPerformancePolicy(value: PerformancePolicy) {
  return Number.isInteger(value.trafficPollSeconds) && value.trafficPollSeconds >= 10 && value.trafficPollSeconds <= 3600
    && Number.isInteger(value.syncIntervalSeconds) && value.syncIntervalSeconds >= 60 && value.syncIntervalSeconds <= 86400
    && Number.isInteger(value.routerHealthSeconds) && value.routerHealthSeconds >= 30 && value.routerHealthSeconds <= 3600
    && Number.isInteger(value.bandwidthSeconds) && value.bandwidthSeconds >= 60 && value.bandwidthSeconds <= 86400
    && Number.isInteger(value.operationReconciliationSeconds) && value.operationReconciliationSeconds >= 30 && value.operationReconciliationSeconds <= 3600
    && Number.isInteger(value.trafficAggregationSeconds) && value.trafficAggregationSeconds >= 300 && value.trafficAggregationSeconds <= 86400
    && Number.isInteger(value.maintenanceSeconds) && value.maintenanceSeconds >= 3600 && value.maintenanceSeconds <= 86400
    && Number.isInteger(value.rawTrafficSampleSeconds) && value.rawTrafficSampleSeconds >= value.trafficPollSeconds && value.rawTrafficSampleSeconds <= 3600
    && Number.isInteger(value.auditRetentionDays) && value.auditRetentionDays >= 0 && value.auditRetentionDays <= 3650
    && ["error", "warn", "info", "debug"].includes(value.logLevel);
}
