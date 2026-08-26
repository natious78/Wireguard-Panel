import { query, withTransaction } from "@/lib/db";
import { applyPeerBandwidth } from "./bandwidth-service";
import { failOperation, finishOperation, operationStep, startOperation } from "./operations";

export type BandwidthPolicyMutation={
  mode:"default"|"unlimited"|"custom"|"profile";profileId?:string|null;downloadBps?:bigint|null;uploadBps?:bigint|null;
  burstDownloadBps?:bigint|null;burstUploadBps?:bigint|null;burstTimeSeconds?:number|null;
};

export async function setPeerBandwidthPolicy(peerId:string,input:BandwidthPolicyMutation,userId:string){
  validateBandwidthMutation(input);
  const peer=(await query<{router_id:string}>("SELECT router_id FROM peers WHERE id=$1",[peerId])).rows[0];if(!peer)throw new Error("Peer not found.");
  if(input.profileId){const profile=await query("SELECT id FROM bandwidth_profiles WHERE id=$1 AND enabled=true",[input.profileId]);if(!profile.rowCount)throw new Error("Bandwidth profile not found or disabled.")}
  const operationId=await startOperation({type:"bandwidth_update",routerId:peer.router_id,peerId,userId,context:{mode:input.mode,profileId:input.profileId??null}});
  try{
    await query(`UPDATE peers SET bandwidth_mode=$2,bandwidth_profile_id=$3,download_limit_bps=$4,upload_limit_bps=$5,
      burst_download_bps=$6,burst_upload_bps=$7,burst_time_seconds=$8,bandwidth_sync_state='pending',updated_at=now() WHERE id=$1`,
      [peerId,input.mode,input.mode==="profile"?input.profileId??null:null,input.mode==="custom"?input.downloadBps?.toString()??null:null,
        input.mode==="custom"?input.uploadBps?.toString()??null:null,input.mode==="custom"?input.burstDownloadBps?.toString()??null:null,
        input.mode==="custom"?input.burstUploadBps?.toString()??null:null,input.mode==="custom"?input.burstTimeSeconds??null:null]);
    await operationStep(operationId,"application_policy","succeeded");
    const result=await applyPeerBandwidth(peerId,{force:true});
    await operationStep(operationId,"router_queue","succeeded",{action:result.action,source:result.policy.source});
    await finishOperation(operationId,"completed");return result;
  }catch(error){await query("UPDATE peers SET bandwidth_sync_state='error',lifecycle_status='needs_reconciliation',updated_at=now() WHERE id=$1",[peerId]).catch(()=>undefined);await failOperation(operationId,error,"needs_reconciliation").catch(()=>undefined);throw error}
}

export async function updateGlobalBandwidth(input:{mode:"unlimited"|"custom";downloadBps?:bigint|null;uploadBps?:bigint|null;applyExisting:boolean;expectedPeerCount?:number},userId:string){
  if(input.mode==="custom"&&(!input.downloadBps||!input.uploadBps))throw new Error("Global custom bandwidth requires download and upload limits.");
  const next={mode:input.mode,downloadBps:input.mode==="custom"?input.downloadBps?.toString()??null:null,uploadBps:input.mode==="custom"?input.uploadBps?.toString()??null:null};
  const prepared=await withTransaction(async db=>{
    const currentResult=await db.query<{value:{mode?:string;downloadBps?:string|number|null;uploadBps?:string|number|null}}>("SELECT value FROM settings WHERE key='bandwidth_defaults' FOR UPDATE");
    const current=currentResult.rows[0]?.value??{mode:"unlimited",downloadBps:null,uploadBps:null};
    const affected=await db.query<{id:string;name:string}>(`SELECT p.id,p.name FROM peers p JOIN routers r ON r.id=p.router_id LEFT JOIN peer_profiles pp ON pp.id=p.profile_id
      WHERE p.bandwidth_mode='default' AND p.bandwidth_profile_id IS NULL AND pp.bandwidth_profile_id IS NULL AND r.default_bandwidth_mode='global' ORDER BY p.name FOR UPDATE OF p`);
    if(input.applyExisting&&input.expectedPeerCount!==affected.rows.length)throw new Error(`The affected peer count changed to ${affected.rows.length}. Review the preview and confirm again.`);
    const unchanged=current.mode===next.mode&&String(current.downloadBps??"")===String(next.downloadBps??"")&&String(current.uploadBps??"")===String(next.uploadBps??"");
    if(unchanged)return{affected:affected.rows,retained:0,unchanged:true};

    // "New users only" must be literal. Existing inheriting peers are pinned to the
    // previous effective policy before the global value changes, so their desired
    // RouterOS queue cannot silently change on the next reconciliation pass.
    if(!input.applyExisting&&affected.rows.length){
      const ids=affected.rows.map(peer=>peer.id);
      if(current.mode==="custom"&&current.downloadBps&&current.uploadBps){
        await db.query(`UPDATE peers SET bandwidth_mode='custom',bandwidth_source='peer',bandwidth_profile_id=NULL,
          download_limit_bps=$2,upload_limit_bps=$3,burst_download_bps=NULL,burst_upload_bps=NULL,
          burst_threshold_download_bps=NULL,burst_threshold_upload_bps=NULL,burst_time_seconds=NULL,updated_at=now()
          WHERE id=ANY($1::uuid[])`,[ids,String(current.downloadBps),String(current.uploadBps)]);
      }else{
        await db.query(`UPDATE peers SET bandwidth_mode='unlimited',bandwidth_source='unlimited',bandwidth_profile_id=NULL,
          download_limit_bps=NULL,upload_limit_bps=NULL,burst_download_bps=NULL,burst_upload_bps=NULL,
          burst_threshold_download_bps=NULL,burst_threshold_upload_bps=NULL,burst_time_seconds=NULL,updated_at=now()
          WHERE id=ANY($1::uuid[])`,[ids]);
      }
    }
    await db.query(`INSERT INTO settings(key,value,updated_by,updated_at) VALUES('bandwidth_defaults',$1,$2,now())
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`,[JSON.stringify(next),userId]);
    return{affected:affected.rows,retained:input.applyExisting?0:affected.rows.length,unchanged:false};
  });
  if(prepared.unchanged||!input.applyExisting)return{affected:prepared.affected.length,updated:0,retained:prepared.retained,failed:[]};
  const failed:Array<{id:string;error:string}>=[];let updated=0;
  for(const peer of prepared.affected){try{await applyPeerBandwidth(peer.id,{force:true});updated+=1}catch(error){failed.push({id:peer.id,error:error instanceof Error?error.message:"Bandwidth update failed"})}}
  return{affected:prepared.affected.length,updated,retained:0,failed};
}

export async function peersUsingGlobalDefault(){
  const result=await query<{id:string;name:string}>(`SELECT p.id,p.name FROM peers p JOIN routers r ON r.id=p.router_id LEFT JOIN peer_profiles pp ON pp.id=p.profile_id
    WHERE p.bandwidth_mode='default' AND p.bandwidth_profile_id IS NULL AND pp.bandwidth_profile_id IS NULL AND r.default_bandwidth_mode='global' ORDER BY p.name`);return result.rows;
}

export async function saveRouterDefaults(routerId:string,input:{interfaceId?:string|null;poolId?:string|null;dns?:string|null;clientAllowedIps?:string|null;endpoint?:string|null;mtu?:number|null;keepalive?:number|null;quotaBytes?:bigint|null;quotaPeriod?:string|null;bandwidthMode:"global"|"unlimited"|"custom";downloadBps?:bigint|null;uploadBps?:bigint|null;expirationDays?:number|null}){
  if(input.interfaceId){const row=await query("SELECT id FROM wireguard_interfaces WHERE id=$1 AND router_id=$2",[input.interfaceId,routerId]);if(!row.rowCount)throw new Error("Default interface does not belong to this router.")}
  if(input.poolId){const row=await query<{interface_id:string}>("SELECT interface_id FROM wireguard_pools WHERE id=$1 AND router_id=$2 AND enabled=true",[input.poolId,routerId]);if(!row.rows[0])throw new Error("Default pool does not belong to this router.");if(input.interfaceId&&row.rows[0].interface_id!==input.interfaceId)throw new Error("Default pool does not belong to the default interface.")}
  if(input.bandwidthMode==="custom"&&(!input.downloadBps||!input.uploadBps))throw new Error("Router custom bandwidth requires download and upload limits.");
  await query(`UPDATE routers SET default_interface_id=$2,default_pool_id=$3,default_dns=$4,default_client_allowed_ips=$5,default_endpoint=$6,
    default_mtu=$7,default_persistent_keepalive=$8,default_quota_bytes=$9,default_quota_period=$10,default_bandwidth_mode=$11,
    default_download_bps=$12,default_upload_bps=$13,default_expiration_days=$14,updated_at=now() WHERE id=$1`,
    [routerId,input.interfaceId??null,input.poolId??null,input.dns?.trim()||null,input.clientAllowedIps?.trim()||null,input.endpoint?.trim()||null,input.mtu??null,
      input.keepalive??null,input.quotaBytes?.toString()??null,input.quotaBytes?input.quotaPeriod??"monthly":null,input.bandwidthMode,
      input.bandwidthMode==="custom"?input.downloadBps?.toString():null,input.bandwidthMode==="custom"?input.uploadBps?.toString():null,input.expirationDays??null]);
}

export async function createBandwidthProfile(input:{name:string;description?:string|null;downloadBps?:bigint|null;uploadBps?:bigint|null;burstDownloadBps?:bigint|null;burstUploadBps?:bigint|null;burstThresholdDownloadBps?:bigint|null;burstThresholdUploadBps?:bigint|null;burstTimeSeconds?:number|null;enabled:boolean},userId:string){
  if(Boolean(input.downloadBps)!==Boolean(input.uploadBps))throw new Error("Set both download and upload, or leave both empty for Unlimited.");
  const result=await query<{id:string}>(`INSERT INTO bandwidth_profiles(name,description,download_bps,upload_bps,burst_download_bps,burst_upload_bps,
    burst_threshold_download_bps,burst_threshold_upload_bps,burst_time_seconds,enabled,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [input.name.trim(),input.description?.trim()||null,input.downloadBps?.toString()??null,input.uploadBps?.toString()??null,input.burstDownloadBps?.toString()??null,
      input.burstUploadBps?.toString()??null,input.burstThresholdDownloadBps?.toString()??null,input.burstThresholdUploadBps?.toString()??null,input.burstTimeSeconds??null,input.enabled,userId]);return result.rows[0].id;
}

export async function createPeerProfile(input:{name:string;description?:string|null;poolId?:string|null;dns?:string|null;clientAllowedIps?:string|null;mtu?:number|null;keepalive?:number|null;quotaBytes?:bigint|null;quotaPeriod?:string|null;bandwidthProfileId?:string|null;expirationDays?:number|null;enabled:boolean},userId:string){
  const result=await query<{id:string}>(`INSERT INTO peer_profiles(name,description,pool_id,dns,client_allowed_ips,mtu,persistent_keepalive,quota_limit_bytes,quota_period,bandwidth_profile_id,expiration_days,enabled,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,[input.name.trim(),input.description?.trim()||null,input.poolId??null,input.dns?.trim()||null,input.clientAllowedIps?.trim()||null,
    input.mtu??null,input.keepalive??null,input.quotaBytes?.toString()??null,input.quotaBytes?input.quotaPeriod??"monthly":null,input.bandwidthProfileId??null,input.expirationDays??null,input.enabled,userId]);return result.rows[0].id;
}

function validateBandwidthMutation(input:BandwidthPolicyMutation){if(input.mode==="custom"&&(!input.downloadBps||!input.uploadBps))throw new Error("Custom bandwidth requires download and upload limits.");if(input.mode==="profile"&&!input.profileId)throw new Error("Select a bandwidth profile.")}
