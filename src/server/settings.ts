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
