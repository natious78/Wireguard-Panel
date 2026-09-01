import type { PoolClient } from "pg";
import { query, withTransaction } from "@/lib/db";
import { logFault, logRecovery } from "@/lib/logger";
import { redactError } from "@/lib/security";
import { clientForRouter, getRouter } from "./router-repository";
import { remotePeerFingerprint } from "./routeros";
import type { RemoteWireGuardPeer, RouterOsClient } from "./routeros";
import { counterDelta, quotaPeriodWindow, type QuotaPeriod, type QuotaPolicy } from "./quota";
import { getPerformancePolicy, getQuotaPolicy, getStatusThresholds, type StatusThresholds } from "./settings";

type AccountingPeer = {
  id: string;
  name: string;
  router_id: string;
  remote_id: string | null;
  public_key: string;
  disabled: boolean;
  expired: boolean;
  disabled_reason: "manual" | "expired" | "quota" | null;
  quota_limit_bytes: string | null;
  quota_period: QuotaPeriod | null;
  quota_period_started_at: Date | null;
  quota_period_ends_at: Date | null;
  period_rx_bytes: string;
  period_tx_bytes: string;
  lifetime_rx_bytes: string;
  lifetime_tx_bytes: string;
  last_observed_rx_bytes: string | null;
  last_observed_tx_bytes: string | null;
  quota_reached_at: Date | null;
  quota_usage_when_disabled: string | null;
  quota_bypass_until: Date | null;
  last_traffic_snapshot_at: Date | null;
};

type Observation = {
  peer: AccountingPeer;
  used: bigint;
  limit: bigint | null;
  rolled: boolean;
  previousUsed: bigint;
};

export async function pollRouterTraffic(routerId: string) {
  let client:RouterOsClient|undefined;
  let observed = 0;
  let disabled = 0;
  let reenabled = 0;
  let failed = 0;
  const attemptedAt=new Date();
  try {
    const router = await getRouter(routerId);
    client = clientForRouter(router);
    const [policy,thresholds,performance] = await Promise.all([getQuotaPolicy(),getStatusThresholds(),getPerformancePolicy()]);
    const [remotePeers, localPeers] = await Promise.all([
      client.getPeers(),
      query<AccountingPeer>("SELECT * FROM peers WHERE router_id=$1 ORDER BY id", [routerId]),
    ]);
    for (const local of localPeers.rows) {
      const remote = remotePeers.find((item) => item.id === local.remote_id || item.publicKey === local.public_key);
      if (!remote) continue;
      try {
        const result = await recordObservation(local.id, remote, policy, thresholds, performance.rawTrafficSampleSeconds);
        observed += 1;
        logRecovery(`traffic-peer:${local.id}`, "Peer traffic accounting recovered", { peer: local.name });
        const action = await enforceObservation(client, remote, result);
        if (action === "disabled") disabled += 1;
        if (action === "reenabled") reenabled += 1;
      } catch (error) {
        failed += 1;
        const signature=redactError(error);
        logFault(`traffic-peer:${local.id}`,signature,"Peer traffic accounting failed",{peer:local.name,error:signature});
      }
    }
    await query(`UPDATE routers SET stats_poll_status='reachable',last_stats_poll_at=$2,last_stats_success_at=$2,
      last_stats_error=NULL,connection_status='connected',last_checked_at=$2,last_successful_connection_at=$2,
      consecutive_failures=0,next_retry_at=NULL,updated_at=now() WHERE id=$1`,[routerId,attemptedAt]);
    return { observed, disabled, reenabled, failed };
  } catch(error) {
    await query(`UPDATE routers SET stats_poll_status='unreachable',last_stats_poll_at=$2,last_stats_error=$3,
      connection_status=CASE WHEN connection_status='auth_failed' THEN connection_status ELSE 'offline' END,
      last_failed_operation_at=$2,last_failed_operation=$3,consecutive_failures=consecutive_failures+1,
      next_retry_at=now()+(LEAST(3600,power(2,LEAST(consecutive_failures,11))*15)::text||' seconds')::interval,
      last_checked_at=$2,updated_at=now() WHERE id=$1`,[routerId,attemptedAt,redactError(error)]).catch(()=>undefined);
    throw error;
  } finally { await client?.close(); }
}

async function recordObservation(peerId: string, remote: RemoteWireGuardPeer, policy: QuotaPolicy, thresholds:StatusThresholds, rawTrafficSampleSeconds:number): Promise<Observation> {
  const now = new Date();
  return withTransaction(async (db) => {
    const locked = await db.query<AccountingPeer>("SELECT * FROM peers WHERE id=$1 FOR UPDATE", [peerId]);
    const peer = locked.rows[0];
    if (!peer) throw new Error("Peer disappeared during traffic accounting.");

    const previousRx = peer.last_observed_rx_bytes === null ? null : BigInt(peer.last_observed_rx_bytes);
    const previousTx = peer.last_observed_tx_bytes === null ? null : BigInt(peer.last_observed_tx_bytes);
    const deltaRx = counterDelta(previousRx, remote.rxBytes);
    const deltaTx = counterDelta(previousTx, remote.txBytes);
    const previousUsed = BigInt(peer.period_rx_bytes) + BigInt(peer.period_tx_bytes);
    let periodRx = BigInt(peer.period_rx_bytes);
    let periodTx = BigInt(peer.period_tx_bytes);
    let periodStart = peer.quota_period_started_at;
    let periodEnd = peer.quota_period_ends_at;
    let rolled = false;

    if (peer.quota_limit_bytes && peer.quota_period) {
      const expected = quotaPeriodWindow(now, peer.quota_period, policy);
      if (peer.quota_period === "one_time") {
        periodStart ??= expected.start;
        periodEnd = null;
      } else if (!periodStart || !periodEnd || now >= new Date(periodEnd)) {
        if (periodStart) await archivePeriod(db, peer, "scheduled", new Date(periodEnd ?? now));
        periodRx = 0n;
        periodTx = 0n;
        periodStart = expected.start;
        periodEnd = expected.end;
        rolled = true;
        await systemAuditWithClient(db, "peer_quota_period_reset", peer.id, "success", {
          period: peer.quota_period,
          previousUsageBytes: previousUsed.toString(),
          newUsageBytes: "0",
          periodStartedAt: expected.start.toISOString(),
          periodEndsAt: expected.end?.toISOString() ?? null,
        });
      }
    }

    periodRx += deltaRx;
    periodTx += deltaTx;
    const lifetimeRx = BigInt(peer.lifetime_rx_bytes) + deltaRx;
    const lifetimeTx = BigInt(peer.lifetime_tx_bytes) + deltaTx;
    const used = periodRx + periodTx;
    const limit = peer.quota_limit_bytes ? BigInt(peer.quota_limit_bytes) : null;
    const reached = Boolean(limit && used >= limit);

    const consideredOnline=Boolean(remote.lastHandshakeAt&&now.getTime()-remote.lastHandshakeAt.getTime()<=thresholds.onlineSeconds*1000);
    const updated = await db.query<AccountingPeer>(
      `UPDATE peers SET rx_bytes=$2,tx_bytes=$3,last_observed_rx_bytes=$2,last_observed_tx_bytes=$3,
       last_counter_observed_at=$4,
       last_handshake_at=CASE WHEN $14 AND $5::timestamptz IS NOT NULL THEN GREATEST(COALESCE(last_handshake_at,$5),$5) ELSE last_handshake_at END,
       last_seen_at=CASE WHEN $14 AND $5::timestamptz IS NOT NULL THEN GREATEST(COALESCE(last_seen_at,$5),$5) ELSE last_seen_at END,
       last_online_at=CASE WHEN $15 THEN $4 ELSE last_online_at END,
       last_statistics_poll_at=$4,last_handshake_raw=$16,last_handshake_parse_valid=$14,remote_disabled=$17,
       period_rx_bytes=$6,period_tx_bytes=$7,lifetime_rx_bytes=$8,lifetime_tx_bytes=$9,
       quota_period_started_at=$10,quota_period_ends_at=$11,
       quota_reached_at=CASE WHEN $12 THEN COALESCE(quota_reached_at,$4) ELSE CASE WHEN $13 THEN NULL ELSE quota_reached_at END END,
       quota_usage_when_disabled=CASE WHEN $13 THEN NULL ELSE quota_usage_when_disabled END,
       quota_bypass_until=CASE WHEN $13 THEN NULL ELSE quota_bypass_until END,
       last_synced_at=$4,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [peer.id, remote.rxBytes.toString(), remote.txBytes.toString(), now, remote.lastHandshakeAt,
        periodRx.toString(), periodTx.toString(), lifetimeRx.toString(), lifetimeTx.toString(),
        periodStart, periodEnd, reached, rolled,remote.lastHandshakeParseValid,consideredOnline,remote.lastHandshakeRaw,remote.disabled],
    );
    const lastSnapshot=peer.last_traffic_snapshot_at?new Date(peer.last_traffic_snapshot_at).getTime():0;
    if(now.getTime()-lastSnapshot>=rawTrafficSampleSeconds*1000){
      await db.query(
        `INSERT INTO traffic_snapshots(peer_id,rx_bytes,tx_bytes,last_handshake_at,captured_at,delta_rx_bytes,delta_tx_bytes,
         lifetime_rx_bytes,lifetime_tx_bytes,period_rx_bytes,period_tx_bytes,quota_period_started_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [peer.id, remote.rxBytes.toString(), remote.txBytes.toString(), remote.lastHandshakeAt, now,
          deltaRx.toString(), deltaTx.toString(), lifetimeRx.toString(), lifetimeTx.toString(), periodRx.toString(), periodTx.toString(), periodStart],
      );
      await db.query("UPDATE peers SET last_traffic_snapshot_at=$2 WHERE id=$1",[peer.id,now]);
    }
    return { peer: updated.rows[0], used, limit, rolled, previousUsed };
  });
}

async function enforceObservation(client: RouterOsClient, remote: RemoteWireGuardPeer, observation: Observation) {
  const { peer, used, limit, rolled } = observation;
  let didReenable=false;
  if (rolled && peer.disabled && peer.disabled_reason === "quota") {
    await setRemoteQuotaState(client, remote, peer, false);
    await systemAudit("peer_quota_auto_reenabled", peer.id, "success", { period: peer.quota_period, usageBytes: used.toString() });
    remote.disabled = false;
    peer.disabled = false;
    peer.disabled_reason = null;
    didReenable=true;
  }
  if (!limit || used < limit) {
    if (peer.disabled && peer.disabled_reason === "quota") {
      await setRemoteQuotaState(client, remote, peer, false);
      await systemAudit("peer_quota_auto_reenabled", peer.id, "success", { reason: "usage_below_limit", usageBytes: used.toString(), limitBytes: limit?.toString() ?? null });
      return "reenabled" as const;
    }
    return didReenable ? "reenabled" as const : "none" as const;
  }
  const bypassActive = peer.quota_bypass_until && new Date(peer.quota_bypass_until) > new Date();
  if (bypassActive || peer.expired || (peer.disabled && peer.disabled_reason !== "quota")) return "none" as const;
  if (peer.disabled && peer.disabled_reason === "quota") return "none" as const;
  if (remote.disabled && !peer.disabled) return "none" as const;
  await setRemoteQuotaState(client, remote, peer, true, used);
  await systemAudit("peer_quota_reached", peer.id, "warning", {
    period: peer.quota_period,
    configuredLimitBytes: limit.toString(),
    usageWhenDisabledBytes: used.toString(),
    overshootBytes: (used - limit).toString(),
  });
  return "disabled" as const;
}

async function setRemoteQuotaState(client: RouterOsClient, remote: RemoteWireGuardPeer, peer: AccountingPeer, disabled: boolean, used?: bigint) {
  await client.updatePeer(remote.id, { disabled });
  const observed = { ...remote, disabled };
  await query(
    `UPDATE peers SET disabled=$2,disabled_reason=$3,
     quota_usage_when_disabled=CASE WHEN $2 THEN $4::bigint ELSE NULL END,
     quota_bypass_until=CASE WHEN $2 THEN NULL ELSE quota_bypass_until END,
     remote_fingerprint=$5,last_remote_state=$6,conflict_type=NULL,conflict_details=NULL,last_synced_at=now(),updated_at=now()
     WHERE id=$1`,
    [peer.id, disabled, disabled ? "quota" : null, used?.toString() ?? null,
      remotePeerFingerprint(observed), JSON.stringify(serializeRemote(observed))],
  );
}

async function archivePeriod(db: PoolClient, peer: AccountingPeer, reason: "scheduled" | "manual" | "configuration_changed" | "limit_removed", endedAt: Date) {
  if (!peer.quota_period || !peer.quota_period_started_at) return;
  await db.query(
    `INSERT INTO quota_period_history(peer_id,quota_period,configured_limit_bytes,rx_bytes,tx_bytes,
     period_started_at,period_ended_at,quota_reached_at,usage_when_disabled,reset_reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [peer.id, peer.quota_period, peer.quota_limit_bytes, peer.period_rx_bytes, peer.period_tx_bytes,
      peer.quota_period_started_at, endedAt, peer.quota_reached_at, peer.quota_usage_when_disabled, reason],
  );
}

function serializeRemote(remote: RemoteWireGuardPeer) {
  return { ...remote, lastHandshakeAt: remote.lastHandshakeAt?.toISOString() ?? null, rxBytes: remote.rxBytes.toString(), txBytes: remote.txBytes.toString() };
}

async function systemAudit(action: string, peerId: string, result: "success" | "failure" | "warning", details: Record<string, unknown>) {
  await query(`INSERT INTO audit_logs(username,action,peer_id,result,details) VALUES('system',$1,$2,$3,$4)`, [action, peerId, result, JSON.stringify(details)]);
}

async function systemAuditWithClient(db: PoolClient, action: string, peerId: string, result: "success" | "failure" | "warning", details: Record<string, unknown>) {
  await db.query(`INSERT INTO audit_logs(username,action,peer_id,result,details) VALUES('system',$1,$2,$3,$4)`, [action, peerId, result, JSON.stringify(details)]);
}

export async function pollAllRouterTraffic() {
  const routers = await query<{ id: string; name: string }>("SELECT id,name FROM routers r WHERE enabled=true AND (next_retry_at IS NULL OR next_retry_at<=now()) AND EXISTS(SELECT 1 FROM peers p WHERE p.router_id=r.id) ORDER BY name");
  const totals = { routers: routers.rowCount ?? 0, observed: 0, disabled: 0, reenabled: 0, failed: 0 };
  for (const router of routers.rows) {
    try {
      const result = await pollRouterTraffic(router.id);
      totals.observed += result.observed;
      totals.disabled += result.disabled;
      totals.reenabled += result.reenabled;
      totals.failed += result.failed;
      logRecovery(`traffic-router:${router.id}`,"Router traffic polling recovered",{router:router.name});
    } catch (error) {
      totals.failed += 1;
      const signature=redactError(error);
      logFault(`traffic-router:${router.id}`,signature,"Router traffic polling failed",{router:router.name,error:signature});
    }
  }
  return totals;
}
