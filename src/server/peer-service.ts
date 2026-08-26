import { randomUUID } from "node:crypto";
import { query, withTransaction } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/security";
import { clientForRouter, getRouter } from "./router-repository";
import { remotePeerFingerprint } from "./routeros";
import type { RemoteWireGuardPeer, RouterOsClient } from "./routeros";
import { generateClientConfig, generateWireGuardKeys } from "./wireguard";
import { quotaPeriodWindow, type QuotaPeriod } from "./quota";
import { getQuotaPolicy } from "./settings";
import { choosePoolAddress,claimPoolAddress,lockPoolForPeer,releasePeerPoolAddress,type WireGuardPool } from "./pool-service";
import { generateQrAssets,refreshPeerQr } from "./qr-service";
import { applyPeerBandwidthRemote, deleteOwnedPeerQueueRemote, getEffectivePeerBandwidth, persistBandwidthResult } from "./bandwidth-service";
import { failOperation, finishOperation, operationStep, startOperation } from "./operations";

export class ReconciliationConflictError extends Error {
  constructor(message: string, public readonly observed?: unknown) { super(message); this.name = "ReconciliationConflictError"; }
}

export type CreatePeerInput = {
  routerId: string;
  interfaceId: string;
  poolId:string;
  assignmentMode:"automatic"|"manual";
  name: string;
  description?: string;
  requestedIp?: string;
  allowedAddress?: string;
  clientAllowedIps?: string;
  dnsServer?: string;
  persistentKeepalive?: number;
  mtu?: number;
  endpointOverride?: string | null;
  endpointPortOverride?: number | null;
  expiresAt?: Date | null;
  usePresharedKey?: boolean;
  quotaBytes?: bigint | null;
  quotaPeriod?: QuotaPeriod | null;
  profileId?: string | null;
  bandwidthMode?: "default" | "unlimited" | "custom" | "profile";
  bandwidthProfileId?: string | null;
  downloadLimitBps?: bigint | null;
  uploadLimitBps?: bigint | null;
  burstDownloadBps?: bigint | null;
  burstUploadBps?: bigint | null;
  burstTimeSeconds?: number | null;
  userId: string;
};

type InterfaceRow = {
  id: string; router_id: string; name: string; public_key: string; listen_port: number; mtu: number;
  client_pool_start: string | null; client_pool_end: string | null; default_dns: string; default_allowed_ips: string;
};

export async function createPeer(input: CreatePeerInput) {
  const peerId = randomUUID();
  const operationId = await startOperation({ type: "peer_create", routerId: input.routerId, userId: input.userId, context: { peerId, name: input.name } });
  const router = await getRouter(input.routerId);
  const interfaceResult = await query<InterfaceRow>("SELECT * FROM wireguard_interfaces WHERE id=$1 AND router_id=$2", [input.interfaceId, input.routerId]);
  const wgInterface = interfaceResult.rows[0];
  if (!wgInterface) throw new Error("WireGuard interface not found on the selected router.");
  const client = clientForRouter(router);
  let remoteId: string | null = null;
  let staged = false;
  const orphan:{ip:string|null;pool:WireGuardPool|null}={ip:null,pool:null};
  try {
    const stagedPeer = await withTransaction(async (db) => {
      const pool=await lockPoolForPeer(db,input.poolId,input.routerId,input.interfaceId);orphan.pool=pool;
      const requested=input.assignmentMode==="manual"?input.requestedIp:undefined;
      const remotePeers=await client.getPeers();
      const clientIp=await choosePoolAddress(db,pool,remotePeers,requested);orphan.ip=clientIp;
      const keys = generateWireGuardKeys(input.usePresharedKey);
      const allowedAddress = `${clientIp}/32`;
      const quotaWindow=input.quotaBytes&&input.quotaPeriod?quotaPeriodWindow(new Date(),input.quotaPeriod,await getQuotaPolicy()):null;
      const endpointHost=input.endpointOverride||pool.endpoint_host||router.endpoint_hostname||router.endpoint_ip||router.management_ip;
      const endpointPort=input.endpointPortOverride||pool.endpoint_port||router.wireguard_port||wgInterface.listen_port;
      const dns=input.dnsServer||pool.dns;const clientAllowed=input.clientAllowedIps||pool.client_allowed_ips;
      const keepalive=input.persistentKeepalive??pool.persistent_keepalive;const mtu=input.mtu??pool.mtu;
      const config=generateClientConfig({privateKey:keys.privateKey,clientIp,dns,serverPublicKey:wgInterface.public_key,presharedKey:keys.presharedKey,
        allowedIps:clientAllowed,endpointHost,endpointPort,persistentKeepalive:keepalive,mtu});
      const qr=await generateQrAssets(config);
      await db.query(
        `INSERT INTO peers(id,router_id, interface_id, remote_id, name, description, origin, public_key,
          private_key_encrypted, preshared_key_encrypted, client_ip, allowed_address, client_allowed_ips,
          dns_server, persistent_keepalive, mtu, expires_at, created_by,
          quota_limit_bytes,quota_period,quota_period_started_at,quota_period_ends_at,
          pool_id,endpoint_override,endpoint_port_override,remote_disabled,last_handshake_parse_valid,
          qr_config_hash,qr_png_encrypted,qr_svg_encrypted,qr_generated_at,profile_id,bandwidth_mode,bandwidth_profile_id,
          download_limit_bps,upload_limit_bps,burst_download_bps,burst_upload_bps,burst_time_seconds,
          lifecycle_status,sync_state,desired_state)
         VALUES($1,$2,$3,NULL,$4,$5,'managed',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
          false,true,$24,$25,$26,now(),$27,$28,$29,$30,$31,$32,$33,$34,'creating','pending',$35)`,
        [peerId,router.id, wgInterface.id, input.name, input.description || null, keys.publicKey,
          encryptSecret(keys.privateKey), keys.presharedKey ? encryptSecret(keys.presharedKey) : null,
          clientIp, allowedAddress, clientAllowed,dns,keepalive,mtu,
          input.expiresAt ?? null,input.userId,
          input.quotaBytes?.toString() ?? null, input.quotaBytes ? input.quotaPeriod : null, quotaWindow?.start ?? null, quotaWindow?.end ?? null,
          pool.id,input.endpointOverride||null,input.endpointPortOverride||null,qr.hash,qr.pngEncrypted,qr.svgEncrypted,
          input.profileId??null,input.bandwidthMode??"default",input.bandwidthProfileId??null,input.downloadLimitBps?.toString()??null,
          input.uploadLimitBps?.toString()??null,input.burstDownloadBps?.toString()??null,input.burstUploadBps?.toString()??null,
          input.burstTimeSeconds??null,JSON.stringify({interfaceName:wgInterface.name,allowedAddress,comment:input.description||"",persistentKeepalive:keepalive,disabled:false})],
      );
      await claimPoolAddress(db,pool,clientIp,peerId,input.name);
      await db.query("UPDATE management_operations SET peer_id=$2,updated_at=now() WHERE id=$1", [operationId, peerId]);
      return { clientIp, keys, allowedAddress, keepalive };
    });
    staged = true;
    await operationStep(operationId, "database_allocation", "succeeded", { clientIp: stagedPeer.clientIp, poolId: input.poolId });

    // Re-check RouterOS immediately before creation. The database lock prevents application races;
    // this second read also catches peers created directly on the router after the first check.
    const latestRemotePeers = await client.getPeers();
    await withTransaction(async (db) => {
      const pool = await lockPoolForPeer(db, input.poolId, input.routerId, input.interfaceId);
      await choosePoolAddress(db, pool, latestRemotePeers, stagedPeer.clientIp, peerId);
    });
    remoteId = await client.createPeer({interfaceName:wgInterface.name,publicKey:stagedPeer.keys.publicKey,allowedAddress:stagedPeer.allowedAddress,
      comment:input.description||"",persistentKeepalive:stagedPeer.keepalive,presharedKey:stagedPeer.keys.presharedKey??undefined});
    const remote=(await client.getPeers()).find(peer=>peer.id===remoteId||peer.publicKey===stagedPeer.keys.publicKey);
    if(!remote)throw new Error("RouterOS created the peer but did not return it during verification.");
    await query(`UPDATE peers SET remote_id=$2,remote_fingerprint=$3,last_remote_state=$4,last_synced_at=now(),
      last_observed_rx_bytes=$5,last_observed_tx_bytes=$6,last_counter_observed_at=now(),remote_disabled=$7,
      last_statistics_poll_at=now(),last_handshake_raw=$8,last_handshake_parse_valid=$9,updated_at=now() WHERE id=$1`,
      [peerId,remote.id,remotePeerFingerprint(remote),JSON.stringify({...remote,rxBytes:remote.rxBytes.toString(),txBytes:remote.txBytes.toString()}),
        remote.rxBytes.toString(),remote.txBytes.toString(),remote.disabled,remote.lastHandshakeRaw,remote.lastHandshakeParseValid]);
    await operationStep(operationId, "router_peer", "succeeded", { remoteId: remote.id });

    const policy = await getEffectivePeerBandwidth(peerId);
    const bandwidth = await applyPeerBandwidthRemote(client, { id: peerId, name: input.name, clientIp: stagedPeer.clientIp }, policy);
    await persistBandwidthResult(undefined, router.id, peerId, policy, bandwidth);
    await operationStep(operationId, "bandwidth", "succeeded", { action: bandwidth.action, source: policy.source });
    await query("UPDATE peers SET lifecycle_status='active',sync_state='synced',last_applied_state=desired_state,updated_at=now() WHERE id=$1", [peerId]);
    await finishOperation(operationId, "completed", { remoteId: remote.id, clientIp: stagedPeer.clientIp });
    return { id: peerId, clientIp:stagedPeer.clientIp,poolId:input.poolId };
  } catch (error) {
    const cleanupErrors: string[] = [];
    if (remoteId) {
      await deleteOwnedPeerQueueRemote(client, peerId).catch((cleanupError) => cleanupErrors.push(`queue: ${cleanupError instanceof Error ? cleanupError.message : "cleanup failed"}`));
      await client.deletePeer(remoteId).catch((cleanupError) => cleanupErrors.push(`peer: ${cleanupError instanceof Error ? cleanupError.message : "cleanup failed"}`));
      const stillRemote = await client.getPeers().then((peers) => peers.some((peer) => peer.id === remoteId)).catch(() => true);
      if (stillRemote) cleanupErrors.push("peer: deletion could not be verified");
    }
    if (staged && cleanupErrors.length === 0) {
      await withTransaction(async (db) => { await releasePeerPoolAddress(db, peerId); await db.query("DELETE FROM peers WHERE id=$1", [peerId]); });
    } else if (staged) {
      await query("UPDATE peers SET lifecycle_status='pending_cleanup',sync_state='error',bandwidth_sync_state='pending_cleanup',updated_at=now() WHERE id=$1", [peerId]).catch(() => undefined);
    }
    await failOperation(operationId,error,cleanupErrors.length?"pending_cleanup":"failed",{peerId,remoteId,clientIp:orphan.ip,cleanupErrors}).catch(()=>undefined);
    throw error;
  } finally {
    await client.close();
  }
}

type ConfigRow = {
  id: string; name: string; private_key_encrypted: string | null; preshared_key_encrypted: string | null;
  client_ip: string | null; dns_server: string; client_allowed_ips: string; persistent_keepalive: number; mtu: number;
  endpoint_override: string | null; endpoint_port_override: number | null; interface_public_key: string; listen_port: number;
  endpoint_hostname: string | null; endpoint_ip: string | null; management_ip: string;
};

export async function getPeerConfig(peerId: string) {
  const result = await query<ConfigRow>(
    `SELECT p.id,p.name,p.private_key_encrypted,p.preshared_key_encrypted,p.client_ip,p.dns_server,
      p.client_allowed_ips,p.persistent_keepalive,p.mtu,p.endpoint_override,p.endpoint_port_override,
      i.public_key interface_public_key,i.listen_port,r.endpoint_hostname,r.endpoint_ip,r.management_ip
     FROM peers p JOIN wireguard_interfaces i ON i.id=p.interface_id JOIN routers r ON r.id=p.router_id WHERE p.id=$1`,
    [peerId],
  );
  const peer = result.rows[0];
  if (!peer) throw new Error("Peer not found.");
  if (!peer.private_key_encrypted || !peer.client_ip) throw new Error("This imported peer has no private key stored by the application, so its client configuration cannot be regenerated.");
  return {
    name: peer.name,
    config: generateClientConfig({
      privateKey: decryptSecret(peer.private_key_encrypted), clientIp: peer.client_ip, dns: peer.dns_server,
      serverPublicKey: peer.interface_public_key,
      presharedKey: peer.preshared_key_encrypted ? decryptSecret(peer.preshared_key_encrypted) : null,
      allowedIps: peer.client_allowed_ips,
      endpointHost: peer.endpoint_override || peer.endpoint_hostname || peer.endpoint_ip || peer.management_ip,
      endpointPort: peer.endpoint_port_override || peer.listen_port,
      persistentKeepalive: peer.persistent_keepalive, mtu: peer.mtu,
    }),
  };
}

export async function setPeerEnabled(peerId: string, enabled: boolean, reason: "manual" | "expired" = "manual") {
  const row = await mutablePeer(peerId);
  if (enabled && row.disabled_reason === "quota") {
    throw new Error("This peer is disabled because its traffic limit was reached. Reset usage, increase/remove the limit, or use temporary re-enable.");
  }
  const router = await getRouter(row.router_id);
  const client = clientForRouter(router);
  try {
    const remote = await assertCurrentRemote(client, row);
    await client.updatePeer(remote.id, { disabled: !enabled });
    const updated = (await client.getPeers()).find((peer) => peer.id === remote.id);
    await query(
      `UPDATE peers SET disabled=$2, expired=CASE WHEN $2=false THEN false ELSE expired END,
       disabled_reason=CASE WHEN $2 THEN $5 ELSE NULL END,quota_bypass_until=CASE WHEN $2 THEN NULL ELSE quota_bypass_until END,
       remote_fingerprint=$3, last_remote_state=$4, conflict_type=NULL, conflict_details=NULL, last_synced_at=now(), updated_at=now() WHERE id=$1`,
      [peerId, !enabled, updated ? remotePeerFingerprint(updated) : row.remote_fingerprint,
        updated ? JSON.stringify({ ...updated, rxBytes: updated.rxBytes.toString(), txBytes: updated.txBytes.toString() }) : null, reason],
    );
  } finally { await client.close(); }
}

export async function deletePeer(peerId: string, userId?: string) {
  const row = await mutablePeer(peerId);
  const operationId = await startOperation({ type: "peer_delete", routerId: row.router_id, peerId, userId: userId ?? null, context: { name: row.name, clientIp: row.client_ip } });
  const router = await getRouter(row.router_id);
  const client = clientForRouter(router);
  let remoteDeleted = false;
  try {
    const remote = await assertCurrentRemote(client, row);
    await query("UPDATE peers SET lifecycle_status='pending_cleanup',updated_at=now() WHERE id=$1", [peerId]);
    await client.deletePeer(remote.id);
    remoteDeleted = true;
    const stillExists = (await client.getPeers()).some((peer) => peer.id === remote.id || peer.publicKey === row.public_key);
    if (stillExists) throw new Error("RouterOS reported success but the peer still exists.");
    await operationStep(operationId, "router_peer", "succeeded", { remoteId: remote.id });
    const queuesRemoved = await deleteOwnedPeerQueueRemote(client, peerId);
    await operationStep(operationId, "bandwidth_cleanup", "succeeded", { queuesRemoved });
    await withTransaction(async db=>{
      const history = await db.query<{ quota_history: unknown }>(
        "SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.period_started_at),'[]'::jsonb) quota_history FROM quota_period_history q WHERE q.peer_id=$1",
        [peerId],
      );
      await db.query(
        `INSERT INTO peer_archives(peer_id,router_id,interface_id,pool_id,name,description,client_ip,created_at,lifetime_rx_bytes,lifetime_tx_bytes,quota_history,deletion_details)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [row.id,row.router_id,row.interface_id,row.pool_id,row.name,row.description,row.client_ip,row.created_at,
          row.lifetime_rx_bytes,row.lifetime_tx_bytes,JSON.stringify(history.rows[0]?.quota_history??[]),JSON.stringify({remoteId:remote.id,queuesRemoved})],
      );
      await releasePeerPoolAddress(db,peerId);
      await db.query("DELETE FROM managed_router_objects WHERE peer_id=$1", [peerId]);
      await db.query("DELETE FROM peers WHERE id=$1",[peerId]);
    });
    await finishOperation(operationId, "completed", { remoteId: remote.id, queuesRemoved });
  } catch (error) {
    if (remoteDeleted) {
      await query("UPDATE peers SET lifecycle_status='pending_cleanup',sync_state='error',bandwidth_sync_state='pending_cleanup',updated_at=now() WHERE id=$1", [peerId]).catch(() => undefined);
      await failOperation(operationId, error, "pending_cleanup", { remotePeerDeleted: true }).catch(() => undefined);
    } else {
      await query("UPDATE peers SET lifecycle_status='active',updated_at=now() WHERE id=$1", [peerId]).catch(() => undefined);
      await failOperation(operationId, error, "failed").catch(() => undefined);
    }
    throw error;
  } finally { await client.close(); }
}

export type UpdatePeerInput = {
  routerId: string;
  interfaceId: string;
  poolId: string;
  clientIp: string;
  name: string;
  description?: string;
  allowedAddress: string;
  clientAllowedIps: string;
  dnsServer: string;
  persistentKeepalive: number;
  mtu: number;
  expiresAt?: Date | null;
  endpointOverride?: string | null;
  endpointPortOverride?: number | null;
  quotaBytes?: bigint | null;
  quotaPeriod?: QuotaPeriod | null;
  profileId?: string | null;
  bandwidthMode?: "default" | "unlimited" | "custom" | "profile";
  bandwidthProfileId?: string | null;
  downloadLimitBps?: bigint | null;
  uploadLimitBps?: bigint | null;
  burstDownloadBps?: bigint | null;
  burstUploadBps?: bigint | null;
  burstTimeSeconds?: number | null;
  userId?: string;
};

export async function updatePeer(peerId: string, input: UpdatePeerInput) {
  const row = await mutablePeer(peerId);
  const operationId = await startOperation({ type: "peer_update", routerId: row.router_id, peerId, userId: input.userId ?? null, context: { targetRouterId: input.routerId, targetInterfaceId: input.interfaceId } });
  const targetInterfaceResult = await query<InterfaceRow>("SELECT * FROM wireguard_interfaces WHERE id=$1 AND router_id=$2", [input.interfaceId,input.routerId]);
  const targetInterface = targetInterfaceResult.rows[0];
  if (!targetInterface) throw new Error("The selected WireGuard interface does not belong to the selected router.");
  const sourceRouter = await getRouter(row.router_id);
  const sourceClient = clientForRouter(sourceRouter);
  const changingRouter = row.router_id !== input.routerId;
  const targetClient = changingRouter ? clientForRouter(await getRouter(input.routerId)) : sourceClient;
  let createdTargetId: string | null = null;
  let sourceDeleted = false;
  let originalRemote:RemoteWireGuardPeer|null=null;
  let sameRouterMutated=false;
  let recoveryTarget:RemoteWireGuardPeer|null=null;
  let recoveryClientIp:string|null=null;
  let databaseCommitted=false;
  try {
    const remote = await assertCurrentRemote(sourceClient, row);
    originalRemote=remote;
    const targetPeers = await targetClient.getPeers();
    const clientIp = await withTransaction(async db=>{
      const pool=await lockPoolForPeer(db,input.poolId,input.routerId,input.interfaceId);
      return choosePoolAddress(db,pool,targetPeers.filter(peer=>peer.publicKey!==row.public_key),input.clientIp,row.id);
    });
    const allowedAddress = replaceClientAddress(input.allowedAddress,clientIp);
    let updated;
    if (changingRouter) {
      if (!row.private_key_encrypted) throw new Error("Imported peers cannot be moved across routers because their client key material is not managed by this application.");
      createdTargetId = await targetClient.createPeer({
        interfaceName:targetInterface.name,publicKey:row.public_key,allowedAddress,comment:input.description||"",
        persistentKeepalive:input.persistentKeepalive,presharedKey:row.preshared_key_encrypted?decryptSecret(row.preshared_key_encrypted):undefined,disabled:true,
      });
      updated=(await targetClient.getPeers()).find(peer=>peer.id===createdTargetId||peer.publicKey===row.public_key);
      if(!updated)throw new Error("The target router created the peer but did not return it during verification.");
      recoveryTarget={...updated,disabled:true};
      recoveryClientIp=clientIp;
      await sourceClient.deletePeer(remote.id);
      sourceDeleted = true;
      await operationStep(operationId, "source_peer", "succeeded", { action: "deleted", remoteId: remote.id });
    } else {
      await sourceClient.updatePeer(remote.id,{interfaceName:targetInterface.name,allowedAddress,comment:input.description||"",persistentKeepalive:input.persistentKeepalive});
      sameRouterMutated=true;
      updated=(await sourceClient.getPeers()).find(peer=>peer.id===remote.id);
    }
    if (!updated) throw new ReconciliationConflictError("The peer disappeared from the router while it was being updated.");
    const quota = await quotaConfiguration(row, input);
    let disabled = row.disabled;
    let disabledReason = row.disabled_reason;
    if (disabledReason === "quota" && (!quota.limit || quota.used < quota.limit)) {
      await targetClient.updatePeer(updated.id, { disabled: false });
      updated = { ...updated, disabled: false };
      disabled = false;
      disabledReason = null;
    } else if (quota.limit && quota.used >= quota.limit && !row.expired && !row.disabled) {
      await targetClient.updatePeer(updated.id, { disabled: true });
      updated = { ...updated, disabled: true };
      disabled = true;
      disabledReason = "quota";
    } else if (changingRouter && !row.disabled) {
      await targetClient.updatePeer(updated.id,{disabled:false});
      updated={...updated,disabled:false};
    }
    const usageWhenDisabled = disabledReason === "quota" ? quota.used : quota.usageWhenDisabled;
    const finalRemotePeers=(await targetClient.getPeers()).filter(peer=>peer.publicKey!==row.public_key);
    await withTransaction(async (db) => {
      const pool=await lockPoolForPeer(db,input.poolId,input.routerId,input.interfaceId);
      const confirmedClientIp=await choosePoolAddress(db,pool,finalRemotePeers,clientIp,row.id);
      if (quota.archive) {
        await db.query(
          `INSERT INTO quota_period_history(peer_id,quota_period,configured_limit_bytes,rx_bytes,tx_bytes,
           period_started_at,period_ended_at,quota_reached_at,usage_when_disabled,reset_reason)
           VALUES($1,$2,$3,$4,$5,$6,now(),$7,$8,$9)`,
          [peerId,row.quota_period,row.quota_limit_bytes,row.period_rx_bytes,row.period_tx_bytes,row.quota_period_started_at,
            row.quota_reached_at,row.quota_usage_when_disabled,quota.archive],
        );
      }
      await db.query(
      `UPDATE peers SET name=$2,description=$3,allowed_address=$4,client_allowed_ips=$5,dns_server=$6,
       persistent_keepalive=$7,mtu=$8,expires_at=$9,endpoint_override=$10,endpoint_port_override=$11,
       remote_fingerprint=$12,last_remote_state=$13,conflict_type=NULL,conflict_details=NULL,last_synced_at=now(),updated_at=now(),
       quota_limit_bytes=$14,quota_period=$15,quota_period_started_at=$16,quota_period_ends_at=$17,
       period_rx_bytes=$18,period_tx_bytes=$19,quota_reached_at=$20,quota_usage_when_disabled=$21,quota_bypass_until=$22,
       disabled=$23,disabled_reason=$24,router_id=$25,interface_id=$26,pool_id=$27,client_ip=$28,remote_id=$29,
       last_observed_rx_bytes=CASE WHEN $30 THEN $31 ELSE last_observed_rx_bytes END,
       last_observed_tx_bytes=CASE WHEN $30 THEN $32 ELSE last_observed_tx_bytes END,
       rx_bytes=CASE WHEN $30 THEN $31 ELSE rx_bytes END,tx_bytes=CASE WHEN $30 THEN $32 ELSE tx_bytes END,
       last_counter_observed_at=CASE WHEN $30 THEN now() ELSE last_counter_observed_at END,
       profile_id=$33,bandwidth_mode=$34,bandwidth_profile_id=$35,download_limit_bps=$36,upload_limit_bps=$37,
       burst_download_bps=$38,burst_upload_bps=$39,burst_time_seconds=$40,lifecycle_status='active',sync_state='synced'
       WHERE id=$1`,
      [peerId,input.name,input.description || null,allowedAddress,input.clientAllowedIps,input.dnsServer,
        input.persistentKeepalive,input.mtu,input.expiresAt ?? null,input.endpointOverride || null,input.endpointPortOverride || null,
        remotePeerFingerprint(updated),JSON.stringify({ ...updated, rxBytes: updated.rxBytes.toString(), txBytes: updated.txBytes.toString() }),
        quota.limit?.toString() ?? null,quota.period,quota.start,quota.end,quota.periodRx.toString(),quota.periodTx.toString(),
        quota.reachedAt,usageWhenDisabled?.toString() ?? null,quota.bypassUntil,disabled,disabledReason,input.routerId,input.interfaceId,input.poolId,confirmedClientIp,updated.id,
        changingRouter,updated.rxBytes.toString(),updated.txBytes.toString(),input.profileId===undefined?row.profile_id:input.profileId,input.bandwidthMode??row.bandwidth_mode,
        input.bandwidthProfileId===undefined?row.bandwidth_profile_id:input.bandwidthProfileId,input.downloadLimitBps===undefined?row.download_limit_bps:input.downloadLimitBps?.toString()??null,
        input.uploadLimitBps===undefined?row.upload_limit_bps:input.uploadLimitBps?.toString()??null,input.burstDownloadBps===undefined?row.burst_download_bps:input.burstDownloadBps?.toString()??null,
        input.burstUploadBps===undefined?row.burst_upload_bps:input.burstUploadBps?.toString()??null,input.burstTimeSeconds===undefined?row.burst_time_seconds:input.burstTimeSeconds??null],
      );
      await releasePeerPoolAddress(db,peerId);
      await claimPoolAddress(db,pool,confirmedClientIp,peerId,input.name);
    });
    databaseCommitted=true;
    await operationStep(operationId, "database_state", "succeeded", { routerId: input.routerId, interfaceId: input.interfaceId, clientIp });
    if(changingRouter)await deleteOwnedPeerQueueRemote(sourceClient,peerId);
    const bandwidthPolicy=await getEffectivePeerBandwidth(peerId);
    const bandwidth=await applyPeerBandwidthRemote(targetClient,{id:peerId,name:input.name,clientIp},bandwidthPolicy,{force:true});
    await persistBandwidthResult(undefined,input.routerId,peerId,bandwidthPolicy,bandwidth);
    await operationStep(operationId,"bandwidth","succeeded",{action:bandwidth.action,source:bandwidthPolicy.source});
    if(row.private_key_encrypted)await refreshPeerQr(peerId);
    await finishOperation(operationId,"completed",{routerId:input.routerId,clientIp});
  } catch(error) {
    if(!databaseCommitted&&sameRouterMutated&&originalRemote){
      await sourceClient.updatePeer(originalRemote.id,{interfaceName:originalRemote.interfaceName,allowedAddress:originalRemote.allowedAddress,comment:originalRemote.comment||"",persistentKeepalive:originalRemote.persistentKeepalive,disabled:originalRemote.disabled}).catch(()=>undefined);
    }
    if(!databaseCommitted&&createdTargetId&&!sourceDeleted)await targetClient.deletePeer(createdTargetId).catch(()=>undefined);
    if(!databaseCommitted&&sourceDeleted&&recoveryTarget&&recoveryClientIp){
      const recovery={...recoveryTarget,disabled:true};
      const recoveryIp=recoveryClientIp;
      await targetClient.updatePeer(recovery.id,{disabled:true}).catch(()=>undefined);
      await withTransaction(async db=>{
        const pool=await lockPoolForPeer(db,input.poolId,input.routerId,input.interfaceId);
        await releasePeerPoolAddress(db,row.id);
        await db.query(`UPDATE peers SET router_id=$2,interface_id=$3,pool_id=$4,remote_id=$5,client_ip=$6,allowed_address=$7,
          disabled=true,disabled_reason='manual',remote_fingerprint=$8,last_remote_state=$9,conflict_type=NULL,conflict_details=NULL,updated_at=now() WHERE id=$1`,
        [row.id,input.routerId,input.interfaceId,input.poolId,recovery.id,recoveryIp,recovery.allowedAddress,remotePeerFingerprint(recovery),JSON.stringify({...recovery,rxBytes:recovery.rxBytes.toString(),txBytes:recovery.txBytes.toString()})]);
        await claimPoolAddress(db,pool,recoveryIp,row.id,row.name);
      }).catch(()=>undefined);
    }
    if(databaseCommitted){
      await query("UPDATE peers SET lifecycle_status='needs_reconciliation',sync_state='error',updated_at=now() WHERE id=$1",[peerId]).catch(()=>undefined);
    }
    await failOperation(operationId,error,databaseCommitted||sourceDeleted||sameRouterMutated?"needs_reconciliation":"failed",
      {databaseCommitted,sourceDeleted,createdTargetId,targetRouterId:input.routerId}).catch(()=>undefined);
    throw error;
  } finally {
    await sourceClient.close();
    if(changingRouter)await targetClient.close();
  }
}

export async function regeneratePeerKeys(peerId: string, usePresharedKey: boolean, userId?:string) {
  const row = await mutablePeer(peerId);
  const operationId=await startOperation({type:"peer_key_rotation",routerId:row.router_id,peerId,userId:userId??null});
  const router = await getRouter(row.router_id);
  const client = clientForRouter(router);
  let remoteMutated=false;let databaseCommitted=false;
  try {
    const remote = await assertCurrentRemote(client, row);
    const keys = generateWireGuardKeys(usePresharedKey);
    await client.updatePeer(remote.id, { publicKey: keys.publicKey, presharedKey: keys.presharedKey ?? "" });
    remoteMutated=true;
    const updated = (await client.getPeers()).find((peer) => peer.id === remote.id || peer.publicKey === keys.publicKey);
    if (!updated) throw new Error("RouterOS did not return the regenerated peer during verification.");
    await query(
      `UPDATE peers SET public_key=$2,private_key_encrypted=$3,preshared_key_encrypted=$4,
       remote_fingerprint=$5,last_remote_state=$6,conflict_type=NULL,conflict_details=NULL,last_synced_at=now(),updated_at=now() WHERE id=$1`,
      [peerId,keys.publicKey,encryptSecret(keys.privateKey),keys.presharedKey ? encryptSecret(keys.presharedKey) : null,
        remotePeerFingerprint(updated),JSON.stringify({ ...updated, rxBytes: updated.rxBytes.toString(), txBytes: updated.txBytes.toString() })],
    );
    databaseCommitted=true;await operationStep(operationId,"router_and_database_keys","succeeded");
    await refreshPeerQr(peerId);
    await operationStep(operationId,"credential_material","succeeded",{previousConfigurationInvalidated:true});await finishOperation(operationId,"completed");
  } catch(error) {
    let rollbackFailed=false;
    if(remoteMutated&&!databaseCommitted){try{const current=(await client.getPeers()).find(peer=>peer.id===row.remote_id);if(current)await client.updatePeer(current.id,{publicKey:row.public_key,presharedKey:row.preshared_key_encrypted?decryptSecret(row.preshared_key_encrypted):""})}catch{rollbackFailed=true}}
    if(rollbackFailed)await query("UPDATE peers SET lifecycle_status='needs_reconciliation',sync_state='error',updated_at=now() WHERE id=$1",[peerId]).catch(()=>undefined);
    await failOperation(operationId,error,rollbackFailed||databaseCommitted?"needs_reconciliation":"failed",{remoteMutated,databaseCommitted,rollbackFailed}).catch(()=>undefined);throw error;
  } finally { await client.close(); }
}

type MutablePeerRow = {
  id:string;name:string;description:string|null;router_id:string;interface_id:string;pool_id:string|null;remote_id:string|null;public_key:string;private_key_encrypted:string|null;preshared_key_encrypted:string|null;client_ip:string|null;allowed_address:string;remote_fingerprint:string|null;created_at:Date;
  lifetime_rx_bytes:string;lifetime_tx_bytes:string;
  profile_id:string|null;bandwidth_mode:"default"|"unlimited"|"custom"|"profile";bandwidth_profile_id:string|null;download_limit_bps:string|null;upload_limit_bps:string|null;burst_download_bps:string|null;burst_upload_bps:string|null;burst_time_seconds:number|null;
  disabled:boolean;expired:boolean;disabled_reason:"manual"|"expired"|"quota"|null;
  quota_limit_bytes:string|null;quota_period:QuotaPeriod|null;quota_period_started_at:Date|null;quota_period_ends_at:Date|null;
  period_rx_bytes:string;period_tx_bytes:string;quota_reached_at:Date|null;quota_usage_when_disabled:string|null;quota_bypass_until:Date|null;
};
async function mutablePeer(peerId: string) {
  const result = await query<MutablePeerRow>("SELECT * FROM peers WHERE id=$1", [peerId]);
  if (!result.rows[0]) throw new Error("Peer not found.");
  return result.rows[0];
}
async function assertCurrentRemote(client: RouterOsClient, row: MutablePeerRow) {
  const remote = (await client.getPeers()).find((peer) => peer.id === row.remote_id || peer.publicKey === row.public_key);
  if (!remote) throw new ReconciliationConflictError("This peer was deleted outside the application. Synchronize before making changes.");
  const fingerprint = remotePeerFingerprint(remote);
  if (row.remote_fingerprint && fingerprint !== row.remote_fingerprint) {
    throw new ReconciliationConflictError("This peer changed on the MikroTik after the last synchronization. Review the conflict before overwriting it.", remote);
  }
  return remote;
}

function replaceClientAddress(existing:string,clientIp:string) {
  const addresses=existing.split(",").map(value=>value.trim()).filter(Boolean);
  if(addresses.length===0)return`${clientIp}/32`;
  addresses[0]=`${clientIp}/32`;
  return addresses.join(",");
}

async function quotaConfiguration(row: MutablePeerRow, input: UpdatePeerInput) {
  const oldLimit = row.quota_limit_bytes ? BigInt(row.quota_limit_bytes) : null;
  const limit = input.quotaBytes === undefined ? oldLimit : input.quotaBytes;
  const period = limit ? (input.quotaPeriod ?? row.quota_period ?? "monthly") : null;
  const adding = !oldLimit && Boolean(limit);
  const removing = Boolean(oldLimit) && !limit;
  const periodChanged = Boolean(oldLimit && limit && row.quota_period !== period);
  const limitChanged = oldLimit !== limit;
  const reset = adding || periodChanged;
  const archive = row.quota_period_started_at && (removing || periodChanged)
    ? (removing ? "limit_removed" : "configuration_changed") as "limit_removed" | "configuration_changed"
    : null;
  if (!limit || !period) {
    return { limit:null,period:null,start:null,end:null,periodRx:0n,periodTx:0n,used:0n,reachedAt:null,usageWhenDisabled:null,bypassUntil:null,archive };
  }
  let start = row.quota_period_started_at;
  let end = row.quota_period_ends_at;
  let periodRx = BigInt(row.period_rx_bytes);
  let periodTx = BigInt(row.period_tx_bytes);
  if (reset || !start) {
    const window = quotaPeriodWindow(new Date(), period, await getQuotaPolicy());
    start = window.start;
    end = window.end;
    periodRx = 0n;
    periodTx = 0n;
  }
  const used = periodRx + periodTx;
  const reached = used >= limit;
  return {
    limit,period,start,end,periodRx,periodTx,used,
    reachedAt:reached ? row.quota_reached_at ?? new Date() : null,
    usageWhenDisabled:reached && row.disabled_reason === "quota" ? used : null,
    bypassUntil:limitChanged || periodChanged ? null : row.quota_bypass_until,
    archive,
  };
}

export async function resetPeerQuotaUsage(peerId: string) {
  const row = await mutablePeer(peerId);
  if (!row.quota_limit_bytes || !row.quota_period) throw new Error("This peer has no traffic limit to reset.");
  const router = await getRouter(row.router_id);
  const client = clientForRouter(router);
  try {
    const remote = await assertCurrentRemote(client, row);
    const previousUsage = BigInt(row.period_rx_bytes) + BigInt(row.period_tx_bytes);
    const window = quotaPeriodWindow(new Date(), row.quota_period, await getQuotaPolicy());
    let observed = remote;
    if (row.disabled && row.disabled_reason === "quota") {
      await client.updatePeer(remote.id, { disabled: false });
      observed = { ...remote, disabled: false };
    }
    await withTransaction(async (db) => {
      if (row.quota_period_started_at) {
        await db.query(
          `INSERT INTO quota_period_history(peer_id,quota_period,configured_limit_bytes,rx_bytes,tx_bytes,
           period_started_at,period_ended_at,quota_reached_at,usage_when_disabled,reset_reason)
           VALUES($1,$2,$3,$4,$5,$6,now(),$7,$8,'manual')`,
          [row.id,row.quota_period,row.quota_limit_bytes,row.period_rx_bytes,row.period_tx_bytes,row.quota_period_started_at,row.quota_reached_at,row.quota_usage_when_disabled],
        );
      }
      await db.query(
        `UPDATE peers SET period_rx_bytes=0,period_tx_bytes=0,quota_period_started_at=$2,quota_period_ends_at=$3,
         quota_reached_at=NULL,quota_usage_when_disabled=NULL,quota_bypass_until=NULL,
         disabled=CASE WHEN disabled_reason='quota' THEN false ELSE disabled END,
         disabled_reason=CASE WHEN disabled_reason='quota' THEN NULL ELSE disabled_reason END,
         remote_fingerprint=$4,last_remote_state=$5,last_synced_at=now(),updated_at=now() WHERE id=$1`,
        [row.id,new Date(),window.end,remotePeerFingerprint(observed),JSON.stringify({ ...observed,rxBytes:observed.rxBytes.toString(),txBytes:observed.txBytes.toString() })],
      );
    });
    return { previousUsageBytes: previousUsage.toString(), newUsageBytes: "0", period: row.quota_period };
  } finally { await client.close(); }
}

export async function temporarilyReenablePeer(peerId: string, minutes = 60) {
  const row = await mutablePeer(peerId);
  if (!row.quota_limit_bytes || !row.quota_reached_at) throw new Error("This peer has not reached a configured traffic limit.");
  if (row.expired || row.disabled_reason === "expired") throw new Error("Expired peers cannot be temporarily re-enabled.");
  if (row.disabled_reason === "manual") throw new Error("This peer was manually disabled. Use the normal Enable action instead.");
  const router = await getRouter(row.router_id);
  const client = clientForRouter(router);
  try {
    const remote = await assertCurrentRemote(client, row);
    await client.updatePeer(remote.id, { disabled: false });
    const observed = { ...remote, disabled: false };
    const until = new Date(Date.now() + minutes * 60_000);
    await query(
      `UPDATE peers SET disabled=false,disabled_reason=NULL,quota_bypass_until=$2,
       remote_fingerprint=$3,last_remote_state=$4,conflict_type=NULL,conflict_details=NULL,last_synced_at=now(),updated_at=now() WHERE id=$1`,
      [row.id,until,remotePeerFingerprint(observed),JSON.stringify({ ...observed,rxBytes:observed.rxBytes.toString(),txBytes:observed.txBytes.toString() })],
    );
    return { until: until.toISOString(), usageBytes: (BigInt(row.period_rx_bytes)+BigInt(row.period_tx_bytes)).toString(), limitBytes: row.quota_limit_bytes };
  } finally { await client.close(); }
}
