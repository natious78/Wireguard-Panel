import { query } from "@/lib/db";
import { env } from "@/lib/env";

export type StatusThresholds={onlineSeconds:number;recentSeconds:number};
export async function getStatusThresholds():Promise<StatusThresholds>{
 try{const result=await query<{value:StatusThresholds}>("SELECT value FROM settings WHERE key='status_thresholds'");const value=result.rows[0]?.value;return value&&value.onlineSeconds>0&&value.recentSeconds>value.onlineSeconds?value:{onlineSeconds:env().ONLINE_THRESHOLD_SECONDS,recentSeconds:env().RECENT_THRESHOLD_SECONDS}}catch{return{onlineSeconds:env().ONLINE_THRESHOLD_SECONDS,recentSeconds:env().RECENT_THRESHOLD_SECONDS}}
}
