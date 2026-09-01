import { query, withTransaction } from "@/lib/db";
import { redactError } from "@/lib/security";
import { clientForRouter, getRouter } from "./router-repository";
import { remoteInterfaceFingerprint, remotePeerFingerprint } from "./routeros";
import type { RemoteWireGuardPeer, RouterOsClient } from "./routeros";
import { classifyPeerSync } from "./reconciliation";
import { getStatusThresholds } from "./settings";
import { fieldDifferences } from "./operations";

type ExistingPeer = {
  id: string;
  remote_id: string | null;
  public_key: string;
  disabled: boolean;
  description: string | null;
  allowed_address: string;
  persistent_keepalive: number;
  interface_name: string;
  remote_fingerprint: string | null;
  last_remote_state: Record<string, unknown> | null;
  desired_state: Record<string, unknown> | null;
  last_applied_state: Record<string, unknown> | null;
};
type ExistingInterface={id:string;remote_id:string;name:string;listen_port:number;mtu:number;public_key:string;disabled:boolean;remote_fingerprint:string|null;last_applied_state:Record<string,unknown>|null};

export async function syncRouter(routerId: string) {
  const run = await query<{ id: string }>("INSERT INTO sync_runs(router_id, status) VALUES ($1,'running') RETURNING id", [routerId]);
  const runId = run.rows[0].id;
  let client:RouterOsClient|undefined;
  const summary = { interfaces: 0, imported: 0, updated: 0, conflicts: 0, missing: 0 };
  try {
    const router = await getRouter(routerId);
    client = clientForRouter(router);
    const [facts,thresholds] = await Promise.all([client.testConnection(),getStatusThresholds()]);
    const [remoteInterfaces, remotePeers, addresses] = await Promise.all([
      client.getInterfaces(), client.getPeers(), client.getAddresses(), client.getRoutes(), client.getNatRules(),
    ]);

    await withTransaction(async (db) => {
      await db.query(
        `UPDATE routers SET connection_status='connected', identity=$2, routeros_version=$3, architecture=$4,
         board_name=$5, uptime=$6, wireguard_supported=$7, last_error=NULL, last_checked_at=now(),
         stats_poll_status='reachable',last_stats_poll_at=now(),last_stats_success_at=now(),last_stats_error=NULL,updated_at=now()
         ,last_successful_connection_at=now(),consecutive_failures=0,next_retry_at=NULL
         WHERE id=$1`,
        [routerId, facts.identity, facts.version, facts.architecture, facts.boardName, facts.uptime, facts.wireguardSupported],
      );

      const interfaceIds = new Map<string, string>();
      const existingInterfaces=await db.query<ExistingInterface>("SELECT id,remote_id,name,listen_port,mtu,public_key,disabled,remote_fingerprint,last_applied_state FROM wireguard_interfaces WHERE router_id=$1",[routerId]);
      for (const item of remoteInterfaces) {
        const interfaceAddresses = addresses.filter((address) => address.interfaceName === item.name && !address.disabled).map((address) => address.address);
        const remoteState=routerInterfaceState(item);const fingerprint=remoteInterfaceFingerprint(item);const found=existingInterfaces.rows.find(existing=>existing.remote_id===item.id);
        if(!found){const result=await db.query<{id:string}>(`INSERT INTO wireguard_interfaces(router_id,remote_id,name,listen_port,mtu,public_key,running,disabled,addresses,remote_fingerprint,last_seen_at,desired_state,last_applied_state,last_remote_state,sync_state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$11,$11,'synced') RETURNING id`,[routerId,item.id,item.name,item.listenPort,item.mtu,item.publicKey,item.running,item.disabled,interfaceAddresses,fingerprint,JSON.stringify(remoteState)]);interfaceIds.set(item.name,result.rows[0].id)}
        else if(found.remote_fingerprint&&found.remote_fingerprint!==fingerprint){const applicationState=applicationInterfaceState(found);const base=Object.keys(found.last_applied_state??{}).length?found.last_applied_state!:applicationState;const differences=fieldDifferences(applicationState,base,remoteState);const state=differences.some(diff=>diff.applicationChanged&&diff.routerChanged)?"conflict":"changed_externally";
          await db.query("UPDATE wireguard_interfaces SET running=$2,addresses=$3,last_remote_state=$4,sync_state=$5,last_seen_at=now(),updated_at=now() WHERE id=$1",[found.id,item.running,interfaceAddresses,JSON.stringify(remoteState),state]);
          await db.query(`INSERT INTO configuration_drifts(router_id,object_type,object_id,state,application_state,synchronized_state,router_state,differences) VALUES($1,'interface',$2,$3,$4,$5,$6,$7)
            ON CONFLICT(object_type,object_id) DO UPDATE SET state=excluded.state,application_state=excluded.application_state,synchronized_state=excluded.synchronized_state,router_state=excluded.router_state,differences=excluded.differences,detected_at=now(),resolved_at=NULL,resolution=NULL,resolved_by=NULL`,[routerId,found.id,state,JSON.stringify(applicationState),JSON.stringify(base),JSON.stringify(remoteState),JSON.stringify(differences)]);interfaceIds.set(item.name,found.id);summary.conflicts+=1}
        else{await db.query(`UPDATE wireguard_interfaces SET name=$2,listen_port=$3,mtu=$4,public_key=$5,running=$6,disabled=$7,addresses=$8,remote_fingerprint=$9,
          desired_state=$10,last_applied_state=$10,last_remote_state=$10,sync_state='synced',last_seen_at=now(),updated_at=now() WHERE id=$1`,[found.id,item.name,item.listenPort,item.mtu,item.publicKey,item.running,item.disabled,interfaceAddresses,fingerprint,JSON.stringify(remoteState)]);await db.query("UPDATE configuration_drifts SET resolved_at=now(),resolution='dismissed' WHERE object_type='interface' AND object_id=$1 AND resolved_at IS NULL",[found.id]);interfaceIds.set(item.name,found.id)}
        summary.interfaces += 1;
      }

      const existing = await db.query<ExistingPeer>(`SELECT p.id,p.remote_id,p.public_key,p.disabled,p.description,p.allowed_address,p.persistent_keepalive,
        i.name interface_name,p.remote_fingerprint,p.last_remote_state,p.desired_state,p.last_applied_state
        FROM peers p JOIN wireguard_interfaces i ON i.id=p.interface_id WHERE p.router_id=$1`, [routerId]);
      const remoteIds = new Set<string>();
      for (const remote of remotePeers) {
        remoteIds.add(remote.id);
        const interfaceId = interfaceIds.get(remote.interfaceName);
        if (!interfaceId) continue;
        const found = existing.rows.find((peer) => peer.remote_id === remote.id || peer.public_key === remote.publicKey);
        const fingerprint = remotePeerFingerprint(remote);
        if (!found) {
          await importPeer(db, routerId, interfaceId, remote, fingerprint,thresholds.onlineSeconds);
          summary.imported += 1;
          continue;
        }
        const legacySyncState = classifyPeerSync({ remoteId: found.remote_id, remoteFingerprint: found.remote_fingerprint, disabled: found.disabled }, remote);
        const applicationState = applicationPeerState(found);
        const synchronizedState = Object.keys(found.last_applied_state ?? {}).length ? found.last_applied_state! : routerPeerStateFromStored(found.last_remote_state);
        const routerState = routerPeerState(remote);
        const differences = fieldDifferences(applicationState, synchronizedState, routerState);
        const changed = legacySyncState === "disabled_externally" || legacySyncState === "modified_externally";
        const hasSameFieldConflict = differences.some((item) => item.applicationChanged && item.routerChanged);
        const state = changed ? (hasSameFieldConflict ? "conflict" : "changed_externally") : "synced";
        const conflictType = changed ? (legacySyncState === "disabled_externally" ? "disabled_externally" : "modified_externally") : null;
        await db.query(
          `UPDATE peers SET remote_id=$2,
           last_handshake_at=CASE WHEN $11 AND $3::timestamptz IS NOT NULL THEN GREATEST(COALESCE(last_handshake_at,$3),$3) ELSE last_handshake_at END,
           last_seen_at=CASE WHEN $11 AND $3::timestamptz IS NOT NULL THEN GREATEST(COALESCE(last_seen_at,$3),$3) ELSE last_seen_at END,
           last_online_at=CASE WHEN $14 THEN now() ELSE last_online_at END,last_statistics_poll_at=now(),
           last_handshake_raw=$12,last_handshake_parse_valid=$11,remote_disabled=$13,
           rx_bytes=$4, tx_bytes=$5, conflict_type=$6, conflict_details=$7, last_remote_state=$8,
           remote_fingerprint=CASE WHEN $6::text IS NULL THEN $9 ELSE remote_fingerprint END,
           sync_state=$10,desired_state=$15,last_applied_state=CASE WHEN $6::text IS NULL THEN $16 ELSE last_applied_state END,
           last_synced_at=now(), updated_at=now()
           WHERE id=$1`,
          [found.id, remote.id, remote.lastHandshakeAt, remote.rxBytes.toString(), remote.txBytes.toString(), conflictType,
            changed ? JSON.stringify({ expectedFingerprint: found.remote_fingerprint, observedFingerprint: fingerprint, observed: serializeRemote(remote) }) : null,
            JSON.stringify(serializeRemote(remote)), fingerprint,state,remote.lastHandshakeParseValid,
            remote.lastHandshakeRaw,remote.disabled,Boolean(remote.lastHandshakeAt&&Date.now()-remote.lastHandshakeAt.getTime()<=thresholds.onlineSeconds*1000),
            JSON.stringify(applicationState),JSON.stringify(routerState)],
        );
        if (changed) {
          await db.query(
            `INSERT INTO configuration_drifts(router_id,peer_id,object_type,object_id,state,application_state,synchronized_state,router_state,differences,detected_at,resolved_at,resolution,resolved_by)
             VALUES($1,$2,'peer',$2,$3,$4,$5,$6,$7,now(),NULL,NULL,NULL)
             ON CONFLICT(object_type,object_id) DO UPDATE SET state=excluded.state,application_state=excluded.application_state,
              synchronized_state=excluded.synchronized_state,router_state=excluded.router_state,differences=excluded.differences,
              detected_at=now(),resolved_at=NULL,resolution=NULL,resolved_by=NULL`,
            [routerId,found.id,state,JSON.stringify(applicationState),JSON.stringify(synchronizedState),JSON.stringify(routerState),JSON.stringify(differences)],
          );
          summary.conflicts += 1;
        } else {
          await db.query("UPDATE configuration_drifts SET resolved_at=now(),resolution='dismissed' WHERE object_type='peer' AND object_id=$1 AND resolved_at IS NULL", [found.id]);
          summary.updated += 1;
        }
      }

      for (const peer of existing.rows) {
        if (peer.remote_id && !remoteIds.has(peer.remote_id)) {
          await db.query(
            `UPDATE peers SET conflict_type='deleted_externally',sync_state='changed_externally', conflict_details=$2, last_synced_at=now(), updated_at=now() WHERE id=$1`,
            [peer.id, JSON.stringify({ message: "Peer is still stored locally but no longer exists on the router." })],
          );
          summary.missing += 1;
        } else if (!peer.remote_id) {
          await db.query("UPDATE peers SET conflict_type='db_only',sync_state='changed_externally', last_synced_at=now() WHERE id=$1", [peer.id]);
          summary.missing += 1;
        }
      }

      await db.query("UPDATE routers SET last_synced_at=now(), updated_at=now() WHERE id=$1", [routerId]);
      await db.query("UPDATE sync_runs SET status=$2, summary=$3, finished_at=now() WHERE id=$1", [runId, summary.conflicts || summary.missing ? "partial" : "succeeded", JSON.stringify(summary)]);
    });
    return summary;
  } catch (error) {
    const message = redactError(error);
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "api_unavailable";
    await query(`UPDATE routers SET connection_status=$2,last_error=$3,last_checked_at=now(),stats_poll_status='unreachable',last_stats_poll_at=now(),last_stats_error=$3,
      last_failed_operation_at=now(),last_failed_operation=$3,consecutive_failures=consecutive_failures+1,
      next_retry_at=now()+(LEAST(3600,power(2,LEAST(consecutive_failures,11))*15)::text||' seconds')::interval,updated_at=now() WHERE id=$1`, [routerId, routerStatus(code), message]);
    await query("UPDATE peers SET sync_state='router_unreachable',bandwidth_sync_state=CASE WHEN bandwidth_sync_state='not_configured' THEN bandwidth_sync_state ELSE 'router_unreachable' END,updated_at=now() WHERE router_id=$1", [routerId]).catch(()=>undefined);
    await query("UPDATE wireguard_interfaces SET sync_state='router_unreachable',updated_at=now() WHERE router_id=$1",[routerId]).catch(()=>undefined);
    await query("UPDATE sync_runs SET status='failed', error=$2, finished_at=now() WHERE id=$1", [runId, message]);
    throw error;
  } finally {
    await client?.close();
  }
}

async function importPeer(db: import("pg").PoolClient, routerId: string, interfaceId: string, remote: RemoteWireGuardPeer, fingerprint: string,onlineSeconds:number) {
  const clientIp = remote.allowedAddress.split(",")[0]?.trim().replace(/\/32$/, "") || null;
  const inserted=await db.query<{id:string}>(
    `INSERT INTO peers(router_id, interface_id, remote_id, name, description, origin, public_key, client_ip,
      allowed_address, persistent_keepalive, disabled, last_handshake_at, last_seen_at, rx_bytes, tx_bytes,
      remote_fingerprint, last_remote_state, last_synced_at,lifetime_rx_bytes,lifetime_tx_bytes,
      period_rx_bytes,period_tx_bytes,last_observed_rx_bytes,last_observed_tx_bytes,last_counter_observed_at,disabled_reason,
      remote_disabled,last_statistics_poll_at,last_online_at,last_handshake_raw,last_handshake_parse_valid,
      desired_state,last_applied_state,sync_state,lifecycle_status)
     VALUES($1,$2,$3,$4,$5,'imported',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),$13,$14,$13,$14,$13,$14,now(),$17,$10,now(),$18,$19,$20,$21,$21,'synced','active')
     ON CONFLICT(router_id, public_key) DO NOTHING RETURNING id`,
    [routerId, interfaceId, remote.id, remote.comment || remote.name || `Imported ${remote.publicKey.slice(0, 8)}`, remote.comment || null, remote.publicKey, clientIp, remote.allowedAddress,
      remote.persistentKeepalive, remote.disabled, remote.lastHandshakeAt, remote.lastHandshakeAt ? new Date() : null,
      remote.rxBytes.toString(), remote.txBytes.toString(), fingerprint, JSON.stringify(serializeRemote(remote)), remote.disabled ? "manual" : null,
      remote.lastHandshakeAt&&Date.now()-remote.lastHandshakeAt.getTime()<=onlineSeconds*1000?new Date():null,remote.lastHandshakeRaw,remote.lastHandshakeParseValid,
      JSON.stringify(routerPeerState(remote))],
  );
  const peerId=inserted.rows[0]?.id;
  if(peerId&&clientIp){const pool=(await db.query<{id:string}>(`SELECT id FROM wireguard_pools WHERE router_id=$1 AND interface_id=$2 AND $3::inet BETWEEN start_ip AND end_ip ORDER BY created_at LIMIT 1`,[routerId,interfaceId,clientIp])).rows[0];if(pool){await db.query("UPDATE peers SET pool_id=$2 WHERE id=$1",[peerId,pool.id]);await db.query(`INSERT INTO wireguard_pool_addresses(pool_id,router_id,interface_id,ip_address,state,peer_id,comment) VALUES($1,$2,$3,$4::inet,'allocated',$5,$6) ON CONFLICT(router_id,ip_address) DO NOTHING`,[pool.id,routerId,interfaceId,clientIp,peerId,remote.comment||remote.name||"Imported MikroTik peer"]);}}
}

function serializeRemote(remote: RemoteWireGuardPeer) {
  return { ...remote, lastHandshakeAt: remote.lastHandshakeAt?.toISOString() ?? null, rxBytes: remote.rxBytes.toString(), txBytes: remote.txBytes.toString() };
}

function applicationPeerState(peer: ExistingPeer) {
  return {
    interfaceName: peer.interface_name,
    publicKey: peer.public_key,
    allowedAddress: peer.allowed_address,
    comment: peer.description ?? "",
    persistentKeepalive: peer.persistent_keepalive,
    disabled: peer.disabled,
  };
}

function routerPeerState(remote: RemoteWireGuardPeer) {
  return {
    interfaceName: remote.interfaceName,
    publicKey: remote.publicKey,
    allowedAddress: remote.allowedAddress,
    comment: remote.comment,
    persistentKeepalive: remote.persistentKeepalive,
    disabled: remote.disabled,
  };
}

function routerPeerStateFromStored(stored: Record<string, unknown> | null) {
  if (!stored) return {};
  return {
    interfaceName: stored.interfaceName,
    publicKey: stored.publicKey,
    allowedAddress: stored.allowedAddress,
    comment: stored.comment,
    persistentKeepalive: stored.persistentKeepalive,
    disabled: stored.disabled,
  };
}
function routerInterfaceState(item:{name:string;listenPort:number;mtu:number;publicKey:string;disabled:boolean}){return{name:item.name,listenPort:item.listenPort,mtu:item.mtu,publicKey:item.publicKey,disabled:item.disabled}}
function applicationInterfaceState(item:ExistingInterface){return{name:item.name,listenPort:item.listen_port,mtu:item.mtu,publicKey:item.public_key,disabled:item.disabled}}

function routerStatus(code: string) {
  return ["auth_failed", "timeout", "tls_error", "unsupported"].includes(code) ? code : "api_unavailable";
}
