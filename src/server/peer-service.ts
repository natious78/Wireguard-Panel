import { query, withTransaction } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/security";
import { allocateClientIp, normalizeClientIp } from "./ip-allocation";
import { clientForRouter, getRouter } from "./router-repository";
import { remotePeerFingerprint } from "./routeros";
import type { RouterOsClient } from "./routeros";
import { generateClientConfig, generateWireGuardKeys } from "./wireguard";

export class ReconciliationConflictError extends Error {
  constructor(message: string, public readonly observed?: unknown) { super(message); this.name = "ReconciliationConflictError"; }
}

export type CreatePeerInput = {
  routerId: string;
  interfaceId: string;
  name: string;
  description?: string;
  requestedIp?: string;
  allowedAddress?: string;
  clientAllowedIps?: string;
  dnsServer?: string;
  persistentKeepalive?: number;
  mtu?: number;
  expiresAt?: Date | null;
  usePresharedKey?: boolean;
  userId: string;
};

type InterfaceRow = {
  id: string; router_id: string; name: string; public_key: string; listen_port: number; mtu: number;
  client_pool_start: string | null; client_pool_end: string | null; default_dns: string; default_allowed_ips: string;
};

export async function createPeer(input: CreatePeerInput) {
  const router = await getRouter(input.routerId);
  const interfaceResult = await query<InterfaceRow>("SELECT * FROM wireguard_interfaces WHERE id=$1 AND router_id=$2", [input.interfaceId, input.routerId]);
  const wgInterface = interfaceResult.rows[0];
  if (!wgInterface) throw new Error("WireGuard interface not found on the selected router.");
  if (!wgInterface.client_pool_start || !wgInterface.client_pool_end) throw new Error("Configure a client IP pool on this interface before creating peers.");
  const client = clientForRouter(router);
  let remoteId: string | null = null;
  try {
    const [remotePeers, dbPeers] = await Promise.all([
      client.getPeers(),
      query<{ client_ip: string | null; name: string }>("SELECT client_ip, name FROM peers WHERE interface_id=$1", [wgInterface.id]),
    ]);
    const used = [
      ...remotePeers.flatMap((peer) => peer.allowedAddress.split(",").map(normalizeClientIp)),
      ...dbPeers.rows.flatMap((peer) => peer.client_ip ? [peer.client_ip] : []),
    ];
    const clientIp = allocateClientIp(wgInterface.client_pool_start, wgInterface.client_pool_end, used, input.requestedIp);
    const keys = generateWireGuardKeys(input.usePresharedKey);
    const allowedAddress = input.allowedAddress || `${clientIp}/32`;
    remoteId = await client.createPeer({
      interfaceName: wgInterface.name,
      publicKey: keys.publicKey,
      allowedAddress,
      comment: input.name,
      persistentKeepalive: input.persistentKeepalive ?? 25,
      presharedKey: keys.presharedKey ?? undefined,
    });
    const remote = (await client.getPeers()).find((peer) => peer.id === remoteId || peer.publicKey === keys.publicKey);
    if (!remote) throw new Error("RouterOS created the peer but did not return it during verification.");
    const fingerprint = remotePeerFingerprint(remote);
    const inserted = await withTransaction(async (db) => {
      const result = await db.query<{ id: string }>(
        `INSERT INTO peers(router_id, interface_id, remote_id, name, description, origin, public_key,
          private_key_encrypted, preshared_key_encrypted, client_ip, allowed_address, client_allowed_ips,
          dns_server, persistent_keepalive, mtu, expires_at, remote_fingerprint, last_remote_state, last_synced_at, created_by)
         VALUES($1,$2,$3,$4,$5,'managed',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),$18) RETURNING id`,
        [router.id, wgInterface.id, remote.id, input.name, input.description || null, keys.publicKey,
          encryptSecret(keys.privateKey), keys.presharedKey ? encryptSecret(keys.presharedKey) : null,
          clientIp, allowedAddress, input.clientAllowedIps || wgInterface.default_allowed_ips,
          input.dnsServer || wgInterface.default_dns, input.persistentKeepalive ?? 25, input.mtu ?? wgInterface.mtu,
          input.expiresAt ?? null, fingerprint, JSON.stringify({ ...remote, rxBytes: remote.rxBytes.toString(), txBytes: remote.txBytes.toString() }), input.userId],
      );
      return result.rows[0].id;
    });
    return { id: inserted, clientIp };
  } catch (error) {
    if (remoteId) await client.deletePeer(remoteId).catch(() => undefined);
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

export async function setPeerEnabled(peerId: string, enabled: boolean) {
  const row = await mutablePeer(peerId);
  const router = await getRouter(row.router_id);
  const client = clientForRouter(router);
  try {
    const remote = await assertCurrentRemote(client, row);
    await client.updatePeer(remote.id, { disabled: !enabled });
    const updated = (await client.getPeers()).find((peer) => peer.id === remote.id);
    await query(
      `UPDATE peers SET disabled=$2, expired=CASE WHEN $2=false THEN false ELSE expired END,
       remote_fingerprint=$3, last_remote_state=$4, conflict_type=NULL, conflict_details=NULL, last_synced_at=now(), updated_at=now() WHERE id=$1`,
      [peerId, !enabled, updated ? remotePeerFingerprint(updated) : row.remote_fingerprint,
        updated ? JSON.stringify({ ...updated, rxBytes: updated.rxBytes.toString(), txBytes: updated.txBytes.toString() }) : null],
    );
  } finally { await client.close(); }
}

export async function deletePeer(peerId: string) {
  const row = await mutablePeer(peerId);
  const router = await getRouter(row.router_id);
  const client = clientForRouter(router);
  try {
    const remote = await assertCurrentRemote(client, row);
    await client.deletePeer(remote.id);
    await query("DELETE FROM peers WHERE id=$1", [peerId]);
  } finally { await client.close(); }
}

export type UpdatePeerInput = {
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
};

export async function updatePeer(peerId: string, input: UpdatePeerInput) {
  const row = await mutablePeer(peerId);
  const router = await getRouter(row.router_id);
  const client = clientForRouter(router);
  try {
    const remote = await assertCurrentRemote(client, row);
    await client.updatePeer(remote.id, {
      allowedAddress: input.allowedAddress,
      comment: input.name,
      persistentKeepalive: input.persistentKeepalive,
    });
    const updated = (await client.getPeers()).find((peer) => peer.id === remote.id);
    if (!updated) throw new ReconciliationConflictError("The peer disappeared from the router while it was being updated.");
    await query(
      `UPDATE peers SET name=$2,description=$3,allowed_address=$4,client_allowed_ips=$5,dns_server=$6,
       persistent_keepalive=$7,mtu=$8,expires_at=$9,endpoint_override=$10,endpoint_port_override=$11,
       remote_fingerprint=$12,last_remote_state=$13,conflict_type=NULL,conflict_details=NULL,last_synced_at=now(),updated_at=now()
       WHERE id=$1`,
      [peerId,input.name,input.description || null,input.allowedAddress,input.clientAllowedIps,input.dnsServer,
        input.persistentKeepalive,input.mtu,input.expiresAt ?? null,input.endpointOverride || null,input.endpointPortOverride || null,
        remotePeerFingerprint(updated),JSON.stringify({ ...updated, rxBytes: updated.rxBytes.toString(), txBytes: updated.txBytes.toString() })],
    );
  } finally { await client.close(); }
}

export async function regeneratePeerKeys(peerId: string, usePresharedKey: boolean) {
  const row = await mutablePeer(peerId);
  const router = await getRouter(row.router_id);
  const client = clientForRouter(router);
  try {
    const remote = await assertCurrentRemote(client, row);
    const keys = generateWireGuardKeys(usePresharedKey);
    await client.updatePeer(remote.id, { publicKey: keys.publicKey, presharedKey: keys.presharedKey ?? "" });
    const updated = (await client.getPeers()).find((peer) => peer.id === remote.id || peer.publicKey === keys.publicKey);
    if (!updated) throw new Error("RouterOS did not return the regenerated peer during verification.");
    await query(
      `UPDATE peers SET public_key=$2,private_key_encrypted=$3,preshared_key_encrypted=$4,
       remote_fingerprint=$5,last_remote_state=$6,conflict_type=NULL,conflict_details=NULL,last_synced_at=now(),updated_at=now() WHERE id=$1`,
      [peerId,keys.publicKey,encryptSecret(keys.privateKey),keys.presharedKey ? encryptSecret(keys.presharedKey) : null,
        remotePeerFingerprint(updated),JSON.stringify({ ...updated, rxBytes: updated.rxBytes.toString(), txBytes: updated.txBytes.toString() })],
    );
  } finally { await client.close(); }
}

type MutablePeerRow = { id: string; router_id: string; remote_id: string | null; public_key: string; remote_fingerprint: string | null };
async function mutablePeer(peerId: string) {
  const result = await query<MutablePeerRow>("SELECT id,router_id,remote_id,public_key,remote_fingerprint FROM peers WHERE id=$1", [peerId]);
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
