import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail,handleApiError,ok } from "@/lib/api";
import { query } from "@/lib/db";

const schema=z.object({
  trafficPollSeconds:z.coerce.number().int().min(10).max(3600),syncIntervalSeconds:z.coerce.number().int().min(60).max(86400),
  routerHealthSeconds:z.coerce.number().int().min(30).max(3600),bandwidthSeconds:z.coerce.number().int().min(60).max(86400),
  operationReconciliationSeconds:z.coerce.number().int().min(30).max(3600),trafficAggregationSeconds:z.coerce.number().int().min(300).max(86400),
  maintenanceSeconds:z.coerce.number().int().min(3600).max(86400),rawTrafficSampleSeconds:z.coerce.number().int().min(30).max(3600),
  auditRetentionDays:z.coerce.number().int().min(0).max(3650),logLevel:z.enum(["error","warn","info","debug"]),
  rawTrafficHours:z.coerce.number().int().min(1).max(744),hourlyDays:z.coerce.number().int().min(1).max(3660),dailyMonths:z.coerce.number().int().min(1).max(120),
}).refine(value=>value.rawTrafficSampleSeconds>=value.trafficPollSeconds,{message:"Raw sample interval cannot be shorter than traffic polling."});

export async function PUT(request:NextRequest){
  const auth=await requireUser("settings:manage");if(!auth.user)return fail(auth.error,auth.status);
  if(!(await validateCsrf(request)))return fail("Security token expired.",403);
  try{
    const value=schema.parse(await request.json());
    const performance={trafficPollSeconds:value.trafficPollSeconds,syncIntervalSeconds:value.syncIntervalSeconds,routerHealthSeconds:value.routerHealthSeconds,
      bandwidthSeconds:value.bandwidthSeconds,operationReconciliationSeconds:value.operationReconciliationSeconds,trafficAggregationSeconds:value.trafficAggregationSeconds,
      maintenanceSeconds:value.maintenanceSeconds,rawTrafficSampleSeconds:value.rawTrafficSampleSeconds,auditRetentionDays:value.auditRetentionDays,logLevel:value.logLevel};
    const retention={rawTrafficHours:value.rawTrafficHours,hourlyDays:value.hourlyDays,dailyMonths:value.dailyMonths,archiveDeletedPeers:true};
    await Promise.all([
      query(`INSERT INTO settings(key,value,updated_by,updated_at) VALUES('performance_policy',$1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`,[JSON.stringify(performance),auth.user.id]),
      query(`INSERT INTO settings(key,value,updated_by,updated_at) VALUES('retention_policy',$1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`,[JSON.stringify(retention),auth.user.id]),
    ]);
    await audit({user:auth.user,action:"performance_settings_updated",result:"success",details:performance});return ok({...performance,...retention});
  }catch(error){return handleApiError(error)}
}
