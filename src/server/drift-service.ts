import { query, withTransaction } from "@/lib/db";
import { choosePoolAddress, claimPoolAddress, lockPoolForPeer, releasePeerPoolAddress } from "./pool-service";
import { applyPeerBandwidth } from "./bandwidth-service";
import { queueOwnershipComment, simpleQueueFingerprint, simpleQueueState } from "./bandwidth";
import { clientForRouter, getRouter } from "./router-repository";
import { remoteInterfaceFingerprint, remotePeerFingerprint, type RemoteWireGuardPeer } from "./routeros";

export class DriftChangedError extends Error {
  constructor(message: string, public readonly current?: unknown) { super(message); this.name = "DriftChangedError"; }
}

type DriftRow = {
  id: string; router_id: string; peer_id: string | null; object_type: "peer" | "interface" | "bandwidth";
  object_id: string; application_state: Record<string, unknown>; router_state: Record<string, unknown>; resolved_at: Date | null;
};

type DriftPeer = {
  id: string; router_id: string; interface_id: string; pool_id: string | null; origin: "managed" | "imported";
  private_key_encrypted: string | null; public_key: string; remote_id: string | null; name: string; client_ip: string | null;
};

export async function resolveConfigurationDrift(driftId: string, resolution: "keep_router" | "apply_application", userId: string) {
  const drift = (await query<DriftRow>("SELECT * FROM configuration_drifts WHERE id=$1", [driftId])).rows[0];
  if (!drift || drift.resolved_at) throw new Error("Open configuration drift not found.");
  if (drift.object_type === "peer") {
    if(!drift.peer_id)throw new Error("Peer drift is missing its peer reference.");
    await resolvePeerDrift(drift, resolution);
  } else if (drift.object_type === "bandwidth") {
    if(!drift.peer_id)throw new Error("Bandwidth drift is missing its peer reference.");
    await resolveBandwidthDrift(drift, resolution);
  } else {
    await resolveInterfaceDrift(drift,resolution);
  }
  await query("UPDATE configuration_drifts SET resolved_at=now(),resolution=$2,resolved_by=$3 WHERE id=$1 AND resolved_at IS NULL", [drift.id, resolution, userId]);
}

async function resolveInterfaceDrift(drift:DriftRow,resolution:"keep_router"|"apply_application"){
  const local=(await query<{id:string;router_id:string;remote_id:string;name:string;listen_port:number;mtu:number;public_key:string;disabled:boolean}>("SELECT id,router_id,remote_id,name,listen_port,mtu,public_key,disabled FROM wireguard_interfaces WHERE id=$1",[drift.object_id])).rows[0];
  if(!local)throw new Error("WireGuard interface not found.");const client=clientForRouter(await getRouter(local.router_id));
  try{const remote=(await client.getInterfaces()).find(item=>item.id===local.remote_id);if(!remote)throw new DriftChangedError("The WireGuard interface no longer exists on RouterOS.");const current={name:remote.name,listenPort:remote.listenPort,mtu:remote.mtu,publicKey:remote.publicKey,disabled:remote.disabled};if(!sameState(current,drift.router_state))throw new DriftChangedError("The interface changed again after this drift was detected.",current);
    let applied=remote;if(resolution==="apply_application"){const state=drift.application_state;await client.updateInterface(remote.id,{name:textField(state,"name"),listenPort:numberField(state,"listenPort"),mtu:numberField(state,"mtu"),disabled:Boolean(state.disabled)});const verified=(await client.getInterfaces()).find(item=>item.id===remote.id);if(!verified)throw new Error("RouterOS interface verification failed.");applied=verified}
    const state={name:applied.name,listenPort:applied.listenPort,mtu:applied.mtu,publicKey:applied.publicKey,disabled:applied.disabled};await withTransaction(async db=>{await db.query(`UPDATE wireguard_interfaces SET name=$2,listen_port=$3,mtu=$4,public_key=$5,disabled=$6,remote_fingerprint=$7,desired_state=$8,last_applied_state=$8,last_remote_state=$8,sync_state='synced',updated_at=now() WHERE id=$1`,[local.id,applied.name,applied.listenPort,applied.mtu,applied.publicKey,applied.disabled,remoteInterfaceFingerprint(applied),JSON.stringify(state)]);if(applied.publicKey!==local.public_key)await db.query("UPDATE peers SET qr_config_hash=NULL,updated_at=now() WHERE interface_id=$1",[local.id])});
  }finally{await client.close()}
}

async function resolvePeerDrift(drift: DriftRow, resolution: "keep_router" | "apply_application") {
  const peer = (await query<DriftPeer>("SELECT * FROM peers WHERE id=$1", [drift.peer_id])).rows[0];
  if (!peer) throw new Error("Peer not found.");
  const router = await getRouter(peer.router_id);
  const client = clientForRouter(router);
  try {
    const peers = await client.getPeers();
    const remote = peers.find((item) => item.id === peer.remote_id || item.publicKey === peer.public_key);
    if (!remote) throw new DriftChangedError("The peer no longer exists on RouterOS.");
    const currentState = peerRouterState(remote);
    if (!sameState(currentState, drift.router_state)) {
      throw new DriftChangedError("RouterOS changed again after this drift was detected. Synchronize and review the new differences.", currentState);
    }

    if (resolution === "apply_application") {
      const state = drift.application_state;
      await client.updatePeer(remote.id, {
        interfaceName: textField(state, "interfaceName"), publicKey: textField(state, "publicKey"),
        allowedAddress: textField(state, "allowedAddress"), comment: textField(state, "comment"),
        persistentKeepalive: numberField(state, "persistentKeepalive"), disabled: Boolean(state.disabled),
      });
      const verified = (await client.getPeers()).find((item) => item.id === remote.id || item.publicKey === state.publicKey);
      if (!verified || !sameState(peerRouterState(verified), state)) throw new Error("RouterOS peer verification failed after applying application state.");
      await storeResolvedPeer(peer.id, verified, state);
      return;
    }

    if (peer.origin === "managed" && peer.private_key_encrypted && remote.publicKey !== peer.public_key) {
      throw new Error("Cannot adopt an externally changed public key for a managed peer because the matching private key is unknown. Apply the application state or rotate keys from this application.");
    }
    const currentInterface = (await query<{ id: string }>("SELECT id FROM wireguard_interfaces WHERE router_id=$1 AND name=$2", [peer.router_id, remote.interfaceName])).rows[0];
    if (!currentInterface) throw new Error("Synchronize interfaces before adopting this RouterOS state.");
    if (currentInterface.id !== peer.interface_id) throw new Error("Adopting an external interface move requires selecting a compatible WireGuard pool in the peer editor.");

    const clientIp = remote.allowedAddress.split(",")[0]?.trim().replace(/\/32$/, "");
    if (!clientIp || !peer.pool_id) throw new Error("A pool-managed client address is required to adopt RouterOS state safely.");
    await withTransaction(async (db) => {
      const pool = await lockPoolForPeer(db, peer.pool_id!, peer.router_id, peer.interface_id);
      const confirmed = await choosePoolAddress(db, pool, peers.filter((item) => item.id !== remote.id), clientIp, peer.id);
      await releasePeerPoolAddress(db, peer.id);
      await claimPoolAddress(db, pool, confirmed, peer.id, peer.name);
      await db.query(
        `UPDATE peers SET public_key=$2,client_ip=$3,allowed_address=$4,description=$5,persistent_keepalive=$6,disabled=$7,
         remote_disabled=$7,remote_fingerprint=$8,last_remote_state=$9,desired_state=$10,last_applied_state=$10,
         conflict_type=NULL,conflict_details=NULL,sync_state='synced',last_synced_at=now(),updated_at=now() WHERE id=$1`,
        [peer.id,remote.publicKey,confirmed,remote.allowedAddress,remote.comment||null,remote.persistentKeepalive,remote.disabled,
          remotePeerFingerprint(remote),JSON.stringify(serializeRemote(remote)),JSON.stringify(currentState)],
      );
    });
  } finally { await client.close(); }
}

async function resolveBandwidthDrift(drift: DriftRow, resolution: "keep_router" | "apply_application") {
  if (!drift.peer_id) throw new Error("Peer not found.");
  if (resolution === "apply_application") {
    await applyPeerBandwidth(drift.peer_id, { force: true });
    return;
  }
  const peer = (await query<DriftPeer>("SELECT * FROM peers WHERE id=$1", [drift.peer_id])).rows[0];
  if (!peer) throw new Error("Peer not found.");
  const router = await getRouter(peer.router_id);
  const client = clientForRouter(router);
  try {
    const owned = (await client.getSimpleQueues()).filter((queue) => queue.comment.trim() === queueOwnershipComment(peer.id));
    if (owned.length !== 1) throw new DriftChangedError("The application-owned queue count changed. Synchronize and review the new state.", owned);
    const current = simpleQueueState(owned[0]);
    if (!sameState(current, drift.router_state)) throw new DriftChangedError("The queue changed again after this drift was detected.", current);
    if (owned[0].disabled) throw new Error("A disabled RouterOS queue cannot be represented as an active bandwidth policy. Delete it or apply the application state.");
    const [upload, download] = parseRatePair(owned[0].maxLimit);
    if (!upload || !download) throw new Error("The RouterOS max-limit cannot be represented by the application.");
    await withTransaction(async (db) => {
      await db.query(`UPDATE peers SET bandwidth_mode='custom',bandwidth_source='peer',download_limit_bps=$2,upload_limit_bps=$3,
        bandwidth_sync_state='synced',updated_at=now() WHERE id=$1`, [peer.id, download.toString(), upload.toString()]);
      await db.query(`UPDATE managed_router_objects SET expected_state=$2,last_observed_state=$2,fingerprint=$3,sync_state='synced',
        last_verified_at=now(),last_error=NULL,updated_at=now() WHERE router_id=$1 AND object_type='simple_queue' AND ownership_comment=$4`,
        [peer.router_id,JSON.stringify(current),simpleQueueFingerprint(owned[0]),queueOwnershipComment(peer.id)]);
    });
  } finally { await client.close(); }
}

async function storeResolvedPeer(peerId: string, remote: RemoteWireGuardPeer, state: Record<string, unknown>) {
  await query(`UPDATE peers SET remote_fingerprint=$2,last_remote_state=$3,desired_state=$4,last_applied_state=$4,
    conflict_type=NULL,conflict_details=NULL,sync_state='synced',remote_disabled=$5,last_synced_at=now(),updated_at=now() WHERE id=$1`,
    [peerId,remotePeerFingerprint(remote),JSON.stringify(serializeRemote(remote)),JSON.stringify(state),remote.disabled]);
}

function peerRouterState(remote: RemoteWireGuardPeer) {
  return { interfaceName:remote.interfaceName,publicKey:remote.publicKey,allowedAddress:remote.allowedAddress,comment:remote.comment,
    persistentKeepalive:remote.persistentKeepalive,disabled:remote.disabled };
}
function serializeRemote(remote: RemoteWireGuardPeer) { return {...remote,lastHandshakeAt:remote.lastHandshakeAt?.toISOString()??null,rxBytes:remote.rxBytes.toString(),txBytes:remote.txBytes.toString()}; }
function sameState(left: Record<string, unknown>, right: Record<string, unknown>) { return JSON.stringify(left) === JSON.stringify(right); }
function textField(state: Record<string, unknown>, key: string) { if (typeof state[key] !== "string") throw new Error(`Invalid ${key} in stored application state.`); return state[key] as string; }
function numberField(state: Record<string, unknown>, key: string) { const value=Number(state[key]);if(!Number.isFinite(value))throw new Error(`Invalid ${key} in stored application state.`);return value; }
function parseRatePair(value: string): [bigint | null, bigint | null] { const [up,down]=value.split("/");return [parseRate(up),parseRate(down)]; }
function parseRate(value?: string) { const match=value?.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([kmgt]?)$/);if(!match)return null;const factor:{[key:string]:number}={"":1,k:1e3,m:1e6,g:1e9,t:1e12};return BigInt(Math.round(Number(match[1])*factor[match[2]])); }
