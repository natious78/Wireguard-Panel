import type { PoolClient } from "pg";
import { query } from "@/lib/db";
import { allowedAddressOwnsIp } from "@/lib/ip-cidr";
import { redactError } from "@/lib/security";
import {
  desiredSimpleQueue,
  queueMatchesDesired,
  queueOwnershipComment,
  queueTargetsIp,
  simpleQueueFingerprint,
  simpleQueueState,
  type DesiredSimpleQueue,
  type EffectiveBandwidthPolicy,
} from "./bandwidth";
import { clientForRouter, getRouter } from "./router-repository";
import type { RemoteFilterRule, RemoteMangleRule, RemoteQueueTree, RemoteSimpleQueue, RouterOsClient } from "./routeros";

export class BandwidthConflictError extends Error {
  constructor(message: string, public readonly conflicts: Array<{ id: string; name: string; target: string; comment: string }> = []) {
    super(message);
    this.name = "BandwidthConflictError";
  }
}

type PolicyPeerRow = {
  id: string;
  router_id: string;
  name: string;
  client_ip: string | null;
  bandwidth_mode: "default" | "unlimited" | "custom" | "profile";
  bandwidth_profile_id: string | null;
  profile_id: string | null;
  download_limit_bps: string | null;
  upload_limit_bps: string | null;
  burst_download_bps: string | null;
  burst_upload_bps: string | null;
  burst_threshold_download_bps: string | null;
  burst_threshold_upload_bps: string | null;
  burst_time_seconds: number | null;
  router_bandwidth_mode: "global" | "unlimited" | "custom";
  router_download_bps: string | null;
  router_upload_bps: string | null;
  peer_profile_bandwidth_id: string | null;
};

type ProfileRow = {
  id: string;
  name: string;
  download_bps: string | null;
  upload_bps: string | null;
  burst_download_bps: string | null;
  burst_upload_bps: string | null;
  burst_threshold_download_bps: string | null;
  burst_threshold_upload_bps: string | null;
  burst_time_seconds: number | null;
};

export type BandwidthApplyResult = {
  state: "not_configured" | "synced";
  desired: DesiredSimpleQueue | null;
  remote: RemoteSimpleQueue | null;
  action: "none" | "created" | "updated" | "deleted";
};

const toBigInt = (value: string | bigint | null | undefined) => value === null || value === undefined ? null : BigInt(value);

export async function getEffectivePeerBandwidth(peerId: string): Promise<EffectiveBandwidthPolicy> {
  const result = await query<PolicyPeerRow>(
    `SELECT p.id,p.router_id,p.name,p.client_ip,p.bandwidth_mode,p.bandwidth_profile_id,p.profile_id,
      p.download_limit_bps,p.upload_limit_bps,p.burst_download_bps,p.burst_upload_bps,
      p.burst_threshold_download_bps,p.burst_threshold_upload_bps,p.burst_time_seconds,
      r.default_bandwidth_mode router_bandwidth_mode,r.default_download_bps router_download_bps,
      r.default_upload_bps router_upload_bps,pp.bandwidth_profile_id peer_profile_bandwidth_id
     FROM peers p JOIN routers r ON r.id=p.router_id
     LEFT JOIN peer_profiles pp ON pp.id=p.profile_id WHERE p.id=$1`,
    [peerId],
  );
  const peer = result.rows[0];
  if (!peer) throw new Error("Peer not found.");

  if (peer.bandwidth_mode === "unlimited") return unlimitedPolicy("Peer override");
  if (peer.bandwidth_mode === "custom") {
    return policyFromValues("peer", "Peer override", peer);
  }

  const profileId = peer.bandwidth_mode === "profile"
    ? peer.bandwidth_profile_id
    : peer.bandwidth_profile_id ?? peer.peer_profile_bandwidth_id;
  if (profileId) {
    const profile = (await query<ProfileRow>("SELECT * FROM bandwidth_profiles WHERE id=$1 AND enabled=true", [profileId])).rows[0];
    if (profile) return profile.download_bps && profile.upload_bps ? policyFromValues("profile", profile.name, profile) : unlimitedPolicy(profile.name);
  }

  if (peer.router_bandwidth_mode === "unlimited") return unlimitedPolicy("Router default");
  if (peer.router_bandwidth_mode === "custom") {
    return {
      source: "router", sourceName: "Router default",
      downloadBps: toBigInt(peer.router_download_bps), uploadBps: toBigInt(peer.router_upload_bps),
      burstDownloadBps: null, burstUploadBps: null, burstThresholdDownloadBps: null,
      burstThresholdUploadBps: null, burstTimeSeconds: null,
    };
  }

  const setting = await query<{ value: { mode?: string; downloadBps?: string | number | null; uploadBps?: string | number | null } }>(
    "SELECT value FROM settings WHERE key='bandwidth_defaults'",
  );
  const global = setting.rows[0]?.value;
  if (!global || global.mode !== "custom" || !global.downloadBps || !global.uploadBps) return unlimitedPolicy("Global default");
  return {
    source: "global", sourceName: "Global default",
    downloadBps: BigInt(global.downloadBps), uploadBps: BigInt(global.uploadBps),
    burstDownloadBps: null, burstUploadBps: null, burstThresholdDownloadBps: null,
    burstThresholdUploadBps: null, burstTimeSeconds: null,
  };
}

export async function applyPeerBandwidth(peerId: string, options: { force?: boolean } = {}) {
  const peer = await loadPeer(peerId);
  if (!peer.client_ip) throw new Error("A client IP is required before bandwidth shaping can be configured.");
  const router = await getRouter(peer.router_id);
  const client = clientForRouter(router);
  try {
    const policy = await getEffectivePeerBandwidth(peerId);
    const result = await applyPeerBandwidthRemote(client, { id: peer.id, name: peer.name, clientIp: peer.client_ip }, policy, options);
    await persistBandwidthResult(undefined, peer.router_id, peer.id, policy, result);
    return { ...result, policy };
  } catch (error) {
    const state = error instanceof BandwidthConflictError ? "conflict" : "error";
    await query("UPDATE peers SET bandwidth_sync_state=$2,updated_at=now() WHERE id=$1", [peerId, state]).catch(() => undefined);
    throw error;
  } finally {
    await client.close();
  }
}

export async function applyPeerBandwidthRemote(
  client: RouterOsClient,
  peer: { id: string; name: string; clientIp: string },
  policy: EffectiveBandwidthPolicy,
  options: { force?: boolean } = {},
): Promise<BandwidthApplyResult> {
  const [queues, queueTrees, mangleRules, filterRules] = await Promise.all([
    client.getSimpleQueues(), client.getQueueTrees(), client.getMangleRules(), client.getFilterRules(),
  ]);
  const owner = queueOwnershipComment(peer.id);
  const owned = queues.filter((queue) => queue.comment.trim() === owner);
  const desired = desiredSimpleQueue(peer, policy);

  if (owned.length > 1) {
    throw new BandwidthConflictError(`Multiple application-owned queues exist for ${peer.name}; automatic changes are blocked.`, owned.map(conflictSummary));
  }

  const conflicting = queues.filter((queue) => queue.comment.trim() !== owner && queueTargetsIp(queue, peer.clientIp));
  if (conflicting.length) {
    throw new BandwidthConflictError(`Bandwidth shaping conflicts with an existing RouterOS queue targeting ${peer.clientIp}.`, conflicting.map(conflictSummary));
  }

  if (desired) {
    const advancedConflicts = advancedShapingConflicts(peer.clientIp, queueTrees, mangleRules);
    if (advancedConflicts.length) {
      throw new BandwidthConflictError(`RouterOS queue-tree or mangle rules already shape ${peer.clientIp}; automatic Simple Queue enforcement is blocked.`, advancedConflicts);
    }
    const fastTrack = enabledFastTrackRules(filterRules);
    if (fastTrack.length) {
      throw new BandwidthConflictError("Enabled RouterOS FastTrack rules may bypass Simple Queue enforcement. Exclude this WireGuard traffic from FastTrack or disable the rule before applying a limit.", fastTrack);
    }
  }

  const current = owned[0] ?? null;
  if (!desired) {
    if (!current) return { state: "not_configured", desired: null, remote: null, action: "none" };
    await client.deleteSimpleQueue(current.id);
    const remaining = (await client.getSimpleQueues()).filter((queue) => queue.comment.trim() === owner);
    if (remaining.length) throw new Error("RouterOS reported success but the application-owned queue still exists.");
    return { state: "not_configured", desired: null, remote: null, action: "deleted" };
  }

  if (current && queueMatchesDesired(current, desired)) {
    return { state: "synced", desired, remote: current, action: "none" };
  }
  if (current && !options.force) {
    throw new BandwidthConflictError("The application-owned queue changed on RouterOS. Review the field-level drift before overwriting it.", [conflictSummary(current)]);
  }

  let remoteId = current?.id;
  if (current) {
    await client.updateSimpleQueue(current.id, desired);
  } else {
    remoteId = await client.createSimpleQueue(desired);
  }
  const verified = (await client.getSimpleQueues()).find((queue) => queue.id === remoteId || queue.comment.trim() === owner);
  if (!verified || !queueMatchesDesired(verified, desired)) {
    throw new Error("RouterOS queue verification failed after the bandwidth change.");
  }
  return { state: "synced", desired, remote: verified, action: current ? "updated" : "created" };
}

export async function deleteOwnedPeerQueueRemote(client: RouterOsClient, peerId: string) {
  const owner = queueOwnershipComment(peerId);
  const owned = (await client.getSimpleQueues()).filter((queue) => queue.comment.trim() === owner);
  for (const queue of owned) await client.deleteSimpleQueue(queue.id);
  const remaining = (await client.getSimpleQueues()).filter((queue) => queue.comment.trim() === owner);
  if (remaining.length) throw new Error("Application-owned RouterOS queue cleanup could not be verified.");
  return owned.length;
}

export async function persistBandwidthResult(
  db: PoolClient | undefined,
  routerId: string,
  peerId: string,
  policy: EffectiveBandwidthPolicy,
  result: BandwidthApplyResult,
) {
  const run = db?.query.bind(db) ?? query;
  await run("UPDATE peers SET bandwidth_source=$2,bandwidth_sync_state=$3,updated_at=now() WHERE id=$1", [peerId, policy.source, result.state]);
  if (!result.desired) {
    await run("DELETE FROM managed_router_objects WHERE router_id=$1 AND object_type='simple_queue' AND ownership_comment=$2", [routerId, queueOwnershipComment(peerId)]);
    return;
  }
  await run(
    `INSERT INTO managed_router_objects(router_id,peer_id,object_type,remote_id,ownership_comment,expected_state,last_observed_state,fingerprint,sync_state,last_verified_at,last_error)
     VALUES($1,$2,'simple_queue',$3,$4,$5,$6,$7,'synced',now(),NULL)
     ON CONFLICT(router_id,object_type,ownership_comment) DO UPDATE SET peer_id=excluded.peer_id,remote_id=excluded.remote_id,
      expected_state=excluded.expected_state,last_observed_state=excluded.last_observed_state,fingerprint=excluded.fingerprint,
      sync_state='synced',last_verified_at=now(),last_error=NULL,updated_at=now()`,
    [routerId, peerId, result.remote?.id ?? null, result.desired.comment, JSON.stringify(simpleQueueState(result.desired)),
      JSON.stringify(result.remote ? simpleQueueState(result.remote) : null), result.remote ? simpleQueueFingerprint(result.remote) : null],
  );
}

export async function observePeerBandwidth(peerId: string) {
  const peer = await loadPeer(peerId);
  if (!peer.client_ip) return { state: "not_configured" as const };
  const router = await getRouter(peer.router_id);
  const client = clientForRouter(router);
  try {
    const policy = await getEffectivePeerBandwidth(peerId);
    const [queues,queueTrees,mangleRules,filterRules]=await Promise.all([client.getSimpleQueues(),client.getQueueTrees(),client.getMangleRules(),client.getFilterRules()]);
    return observePeerWithQueues(peer, policy, queues,queueTrees,mangleRules,filterRules);
  } catch (error) {
    await query("UPDATE peers SET bandwidth_sync_state='router_unreachable',updated_at=now() WHERE id=$1", [peer.id]).catch(() => undefined);
    throw error;
  } finally { await client.close(); }
}

export async function observeAllBandwidth() {
  const routers=await query<{id:string;name:string}>("SELECT id,name FROM routers WHERE enabled=true AND (next_retry_at IS NULL OR next_retry_at<=now()) ORDER BY name");
  const totals={routers:routers.rows.length,peers:0,drifts:0,failed:0};
  for(const routerRow of routers.rows){
    const router=await getRouter(routerRow.id);const client=clientForRouter(router);
    try{
      const [queues,queueTrees,mangleRules,filterRules,peers]=await Promise.all([client.getSimpleQueues(),client.getQueueTrees(),client.getMangleRules(),client.getFilterRules(),query<{id:string;router_id:string;name:string;client_ip:string|null}>(
        "SELECT id,router_id,name,host(client_ip) client_ip FROM peers WHERE router_id=$1 AND lifecycle_status IN ('active','needs_reconciliation') AND client_ip IS NOT NULL ORDER BY id",[router.id])]);
      for(const peer of peers.rows){
        try{const result=await observePeerWithQueues(peer,await getEffectivePeerBandwidth(peer.id),queues,queueTrees,mangleRules,filterRules);totals.peers+=1;if(result.state!=="synced")totals.drifts+=1}
        catch{totals.failed+=1}
      }
    }catch{
      totals.failed+=1;
      await query("UPDATE peers SET bandwidth_sync_state=CASE WHEN bandwidth_sync_state='not_configured' THEN bandwidth_sync_state ELSE 'router_unreachable' END,updated_at=now() WHERE router_id=$1",[router.id]).catch(()=>undefined);
    }finally{await client.close()}
  }
  return totals;
}

async function observePeerWithQueues(peer:{id:string;router_id:string;name:string;client_ip:string|null},policy:EffectiveBandwidthPolicy,queues:RemoteSimpleQueue[],queueTrees:RemoteQueueTree[]=[],mangleRules:RemoteMangleRule[]=[],filterRules:RemoteFilterRule[]=[]){
  if(!peer.client_ip)return{state:"not_configured" as const,policy,desired:null,owned:[],conflicts:[]};
  const desired=desiredSimpleQueue({id:peer.id,name:peer.name,clientIp:peer.client_ip},policy);const owner=queueOwnershipComment(peer.id);
  const owned=queues.filter((queue)=>queue.comment.trim()===owner);const conflicts=[...queues.filter((queue)=>queue.comment.trim()!==owner&&queueTargetsIp(queue,peer.client_ip!)).map(conflictSummary),...(desired?advancedShapingConflicts(peer.client_ip,queueTrees,mangleRules):[]),...(desired?enabledFastTrackRules(filterRules):[])];
  const state=conflicts.length?"conflict":owned.length>1?"duplicate":desired&&!owned.length?"missing":!desired&&owned.length?"changed_externally":desired&&owned[0]&&!queueMatchesDesired(owned[0],desired)?"changed_externally":"synced";
  await query("UPDATE peers SET bandwidth_source=$2,bandwidth_sync_state=$3,updated_at=now() WHERE id=$1",[peer.id,policy.source,state]);
  if(state!=="synced"){
    const current=conflicts.length?{conflicts}:owned[0]?simpleQueueState(owned[0]):{};
    await query(`INSERT INTO configuration_drifts(router_id,peer_id,object_type,object_id,state,application_state,synchronized_state,router_state,differences,detected_at,resolved_at,resolution,resolved_by)
      VALUES($1,$2,'bandwidth',$2,$3,$4,COALESCE((SELECT expected_state FROM managed_router_objects WHERE router_id=$1 AND object_type='simple_queue' AND ownership_comment=$5),'{}'),$6,$7,now(),NULL,NULL,NULL)
      ON CONFLICT(object_type,object_id) DO UPDATE SET state=excluded.state,application_state=excluded.application_state,synchronized_state=excluded.synchronized_state,
      router_state=excluded.router_state,differences=excluded.differences,detected_at=now(),resolved_at=NULL,resolution=NULL,resolved_by=NULL`,
      [peer.router_id,peer.id,state==="changed_externally"?"changed_externally":"conflict",JSON.stringify(desired?simpleQueueState(desired):{}),owner,JSON.stringify(current),JSON.stringify(bandwidthDifferences(desired?simpleQueueState(desired):{},current))]);
  }else await query("UPDATE configuration_drifts SET resolved_at=now(),resolution='dismissed' WHERE object_type='bandwidth' AND object_id=$1 AND resolved_at IS NULL",[peer.id]);
  return{state,policy,desired,owned,conflicts};
}

async function loadPeer(peerId: string) {
  const result = await query<{ id: string; router_id: string; name: string; client_ip: string | null }>("SELECT id,router_id,name,host(client_ip) client_ip FROM peers WHERE id=$1", [peerId]);
  const peer = result.rows[0];
  if (!peer) throw new Error("Peer not found.");
  return peer;
}

function unlimitedPolicy(sourceName: string): EffectiveBandwidthPolicy {
  return { source: "unlimited", sourceName, downloadBps: null, uploadBps: null, burstDownloadBps: null, burstUploadBps: null,
    burstThresholdDownloadBps: null, burstThresholdUploadBps: null, burstTimeSeconds: null };
}

function policyFromValues(source: "peer" | "profile", sourceName: string, values: Partial<ProfileRow & PolicyPeerRow>): EffectiveBandwidthPolicy {
  return {
    source, sourceName,
    downloadBps: toBigInt(values.download_bps ?? values.download_limit_bps),
    uploadBps: toBigInt(values.upload_bps ?? values.upload_limit_bps),
    burstDownloadBps: toBigInt(values.burst_download_bps), burstUploadBps: toBigInt(values.burst_upload_bps),
    burstThresholdDownloadBps: toBigInt(values.burst_threshold_download_bps),
    burstThresholdUploadBps: toBigInt(values.burst_threshold_upload_bps), burstTimeSeconds: values.burst_time_seconds ?? null,
  };
}

function conflictSummary(queue: RemoteSimpleQueue) {
  return { id: queue.id, name: queue.name, target: queue.target, comment: queue.comment };
}

export function enabledFastTrackRules(rules:RemoteFilterRule[]){
  return rules.filter(rule=>!recordDisabled(rule)&&String(rule.action??"").toLowerCase()==="fasttrack-connection")
    .map(rule=>({id:rule[".id"]??"",name:"FastTrack filter rule",target:rule.chain??"forward",comment:rule.comment??"Enabled FastTrack may bypass Simple Queues"}));
}

function advancedShapingConflicts(peerIp:string,trees:RemoteQueueTree[],mangleRules:RemoteMangleRule[]){
  const relevant=mangleRules.filter(rule=>!recordDisabled(rule)&&(recordTargetsIp(rule["src-address"],peerIp)||recordTargetsIp(rule["dst-address"],peerIp)));
  const packetMarks=new Set(relevant.map(rule=>rule["new-packet-mark"]).filter(Boolean));
  return trees.filter(tree=>!recordDisabled(tree)&&Boolean(tree["packet-mark"]&&packetMarks.has(tree["packet-mark"])))
    .map(tree=>({id:tree[".id"]??"",name:tree.name??"Queue tree",target:peerIp,comment:tree.comment??`Uses packet mark ${tree["packet-mark"]}`}));
}

function recordDisabled(record:Record<string,string>){return ["yes","true","1"].includes(String(record.disabled??"").toLowerCase())}
function recordTargetsIp(value:string|undefined,ip:string){if(!value||value.startsWith("!"))return false;try{return allowedAddressOwnsIp(value,ip)}catch{return value===ip}}

function bandwidthDifferences(application: Record<string, unknown>, router: Record<string, unknown>) {
  return [...new Set([...Object.keys(application), ...Object.keys(router)])].flatMap((field) =>
    JSON.stringify(application[field]) === JSON.stringify(router[field]) ? [] : [{ field, application: application[field] ?? null, router: router[field] ?? null }],
  );
}

export function bandwidthErrorDetails(error: unknown) {
  return error instanceof BandwidthConflictError ? { message: error.message, conflicts: error.conflicts } : { message: redactError(error) };
}
