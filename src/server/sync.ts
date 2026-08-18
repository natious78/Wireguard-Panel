import { query, withTransaction } from "@/lib/db";
import { redactError } from "@/lib/security";
import { clientForRouter, getRouter } from "./router-repository";
import { remoteInterfaceFingerprint, remotePeerFingerprint } from "./routeros";
import type { RemoteWireGuardPeer } from "./routeros";
import { classifyPeerSync } from "./reconciliation";
import { getStatusThresholds } from "./settings";

type ExistingPeer = {
  id: string;
  remote_id: string | null;
  public_key: string;
  disabled: boolean;
  remote_fingerprint: string | null;
  last_remote_state: Record<string, unknown> | null;
};

export async function syncRouter(routerId: string) {
  const run = await query<{ id: string }>("INSERT INTO sync_runs(router_id, status) VALUES ($1,'running') RETURNING id", [routerId]);
  const runId = run.rows[0].id;
  const router = await getRouter(routerId);
  const client = clientForRouter(router);
  const summary = { interfaces: 0, imported: 0, updated: 0, conflicts: 0, missing: 0 };
  try {
    const [facts,thresholds] = await Promise.all([client.testConnection(),getStatusThresholds()]);
    const [remoteInterfaces, remotePeers, addresses] = await Promise.all([
      client.getInterfaces(), client.getPeers(), client.getAddresses(), client.getRoutes(), client.getNatRules(),
    ]);

    await withTransaction(async (db) => {
      await db.query(
        `UPDATE routers SET connection_status='connected', identity=$2, routeros_version=$3, architecture=$4,
         board_name=$5, uptime=$6, wireguard_supported=$7, last_error=NULL, last_checked_at=now(),
         stats_poll_status='reachable',last_stats_poll_at=now(),last_stats_success_at=now(),last_stats_error=NULL,updated_at=now()
         WHERE id=$1`,
        [routerId, facts.identity, facts.version, facts.architecture, facts.boardName, facts.uptime, facts.wireguardSupported],
      );

      const interfaceIds = new Map<string, string>();
      for (const item of remoteInterfaces) {
        const interfaceAddresses = addresses.filter((address) => address.interfaceName === item.name && !address.disabled).map((address) => address.address);
        const result = await db.query<{ id: string }>(
          `INSERT INTO wireguard_interfaces(router_id, remote_id, name, listen_port, mtu, public_key, running, disabled, addresses, remote_fingerprint, last_seen_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
           ON CONFLICT(router_id, remote_id) DO UPDATE SET name=excluded.name, listen_port=excluded.listen_port,
             mtu=excluded.mtu, public_key=excluded.public_key, running=excluded.running, disabled=excluded.disabled,
             addresses=excluded.addresses, remote_fingerprint=excluded.remote_fingerprint, last_seen_at=now(), updated_at=now()
           RETURNING id`,
          [routerId, item.id, item.name, item.listenPort, item.mtu, item.publicKey, item.running, item.disabled, interfaceAddresses, remoteInterfaceFingerprint(item)],
        );
        interfaceIds.set(item.name, result.rows[0].id);
        summary.interfaces += 1;
      }

      const existing = await db.query<ExistingPeer>("SELECT id, remote_id, public_key, disabled, remote_fingerprint, last_remote_state FROM peers WHERE router_id=$1", [routerId]);
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
        const previousComment = typeof found.last_remote_state?.comment === "string" ? found.last_remote_state.comment : null;
        const commentOnlyChange = previousComment !== null && found.remote_fingerprint === remotePeerFingerprint({ ...remote, comment: previousComment });
        const syncState = commentOnlyChange ? "in_sync" : classifyPeerSync({ remoteId: found.remote_id, remoteFingerprint: found.remote_fingerprint, disabled: found.disabled }, remote);
        const conflict = syncState === "disabled_externally" || syncState === "modified_externally";
        const conflictType = conflict ? syncState : null;
        await db.query(
          `UPDATE peers SET remote_id=$2,
           last_handshake_at=CASE WHEN $11 AND $3::timestamptz IS NOT NULL THEN GREATEST(COALESCE(last_handshake_at,$3),$3) ELSE last_handshake_at END,
           last_seen_at=CASE WHEN $11 AND $3::timestamptz IS NOT NULL THEN GREATEST(COALESCE(last_seen_at,$3),$3) ELSE last_seen_at END,
           last_online_at=CASE WHEN $14 THEN now() ELSE last_online_at END,last_statistics_poll_at=now(),
           last_handshake_raw=$12,last_handshake_parse_valid=$11,remote_disabled=$13,
           rx_bytes=$4, tx_bytes=$5, conflict_type=$6, conflict_details=$7, last_remote_state=$8,
           remote_fingerprint=CASE WHEN $6::text IS NULL THEN $9 ELSE remote_fingerprint END,
           description=$10,last_synced_at=now(), updated_at=now()
           WHERE id=$1`,
          [found.id, remote.id, remote.lastHandshakeAt, remote.rxBytes.toString(), remote.txBytes.toString(), conflictType,
            conflict ? JSON.stringify({ expectedFingerprint: found.remote_fingerprint, observedFingerprint: fingerprint, observed: serializeRemote(remote) }) : null,
            JSON.stringify(serializeRemote(remote)), fingerprint, remote.comment || null,remote.lastHandshakeParseValid,
            remote.lastHandshakeRaw,remote.disabled,Boolean(remote.lastHandshakeAt&&Date.now()-remote.lastHandshakeAt.getTime()<=thresholds.onlineSeconds*1000)],
        );
        if (conflict) summary.conflicts += 1; else summary.updated += 1;
      }

      for (const peer of existing.rows) {
        if (peer.remote_id && !remoteIds.has(peer.remote_id)) {
          await db.query(
            `UPDATE peers SET conflict_type='deleted_externally', conflict_details=$2, last_synced_at=now(), updated_at=now() WHERE id=$1`,
            [peer.id, JSON.stringify({ message: "Peer is still stored locally but no longer exists on the router." })],
          );
          summary.missing += 1;
        } else if (!peer.remote_id) {
          await db.query("UPDATE peers SET conflict_type='db_only', last_synced_at=now() WHERE id=$1", [peer.id]);
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
    await query("UPDATE routers SET connection_status=$2, last_error=$3, last_checked_at=now(),stats_poll_status='unreachable',last_stats_poll_at=now(),last_stats_error=$3,updated_at=now() WHERE id=$1", [routerId, routerStatus(code), message]);
    await query("UPDATE sync_runs SET status='failed', error=$2, finished_at=now() WHERE id=$1", [runId, message]);
    throw error;
  } finally {
    await client.close();
  }
}

async function importPeer(db: import("pg").PoolClient, routerId: string, interfaceId: string, remote: RemoteWireGuardPeer, fingerprint: string,onlineSeconds:number) {
  const clientIp = remote.allowedAddress.split(",")[0]?.trim().replace(/\/32$/, "") || null;
  const inserted=await db.query<{id:string}>(
    `INSERT INTO peers(router_id, interface_id, remote_id, name, description, origin, public_key, client_ip,
      allowed_address, persistent_keepalive, disabled, last_handshake_at, last_seen_at, rx_bytes, tx_bytes,
      remote_fingerprint, last_remote_state, last_synced_at,lifetime_rx_bytes,lifetime_tx_bytes,
      period_rx_bytes,period_tx_bytes,last_observed_rx_bytes,last_observed_tx_bytes,last_counter_observed_at,disabled_reason,
      remote_disabled,last_statistics_poll_at,last_online_at,last_handshake_raw,last_handshake_parse_valid)
     VALUES($1,$2,$3,$4,$5,'imported',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),$13,$14,$13,$14,$13,$14,now(),$17,$10,now(),$18,$19,$20)
     ON CONFLICT(router_id, public_key) DO NOTHING RETURNING id`,
    [routerId, interfaceId, remote.id, remote.comment || remote.name || `Imported ${remote.publicKey.slice(0, 8)}`, remote.comment || null, remote.publicKey, clientIp, remote.allowedAddress,
      remote.persistentKeepalive, remote.disabled, remote.lastHandshakeAt, remote.lastHandshakeAt ? new Date() : null,
      remote.rxBytes.toString(), remote.txBytes.toString(), fingerprint, JSON.stringify(serializeRemote(remote)), remote.disabled ? "manual" : null,
      remote.lastHandshakeAt&&Date.now()-remote.lastHandshakeAt.getTime()<=onlineSeconds*1000?new Date():null,remote.lastHandshakeRaw,remote.lastHandshakeParseValid],
  );
  const peerId=inserted.rows[0]?.id;
  if(peerId&&clientIp){const pool=(await db.query<{id:string}>(`SELECT id FROM wireguard_pools WHERE router_id=$1 AND interface_id=$2 AND $3::inet BETWEEN start_ip AND end_ip ORDER BY created_at LIMIT 1`,[routerId,interfaceId,clientIp])).rows[0];if(pool){await db.query("UPDATE peers SET pool_id=$2 WHERE id=$1",[peerId,pool.id]);await db.query(`INSERT INTO wireguard_pool_addresses(pool_id,router_id,interface_id,ip_address,state,peer_id,comment) VALUES($1,$2,$3,$4::inet,'allocated',$5,$6) ON CONFLICT(router_id,ip_address) DO NOTHING`,[pool.id,routerId,interfaceId,clientIp,peerId,remote.comment||remote.name||"Imported MikroTik peer"]);}}
}

function serializeRemote(remote: RemoteWireGuardPeer) {
  return { ...remote, lastHandshakeAt: remote.lastHandshakeAt?.toISOString() ?? null, rxBytes: remote.rxBytes.toString(), txBytes: remote.txBytes.toString() };
}

function routerStatus(code: string) {
  return ["auth_failed", "timeout", "tls_error", "unsupported"].includes(code) ? code : "api_unavailable";
}
