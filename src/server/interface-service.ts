import { query } from "@/lib/db";
import { clientForRouter, getRouter } from "./router-repository";
import { remoteInterfaceFingerprint } from "./routeros";
import { ReconciliationConflictError } from "./peer-service";

type InterfaceRow = {
  id: string; router_id: string; remote_id: string; remote_fingerprint: string | null;
};

export type InterfaceInput = {
  name: string; listenPort: number; mtu: number; disabled: boolean;
  clientPoolStart?: string; clientPoolEnd?: string; defaultDns: string; defaultAllowedIps: string;
};

export async function updateInterface(id: string, input: InterfaceInput) {
  const local = await getInterface(id);
  const router = await getRouter(local.router_id);
  const client = clientForRouter(router);
  try {
    const remote = (await client.getInterfaces()).find((item) => item.id === local.remote_id);
    if (!remote) throw new ReconciliationConflictError("This interface was deleted outside the application. Synchronize before making changes.");
    if (local.remote_fingerprint && remoteInterfaceFingerprint(remote) !== local.remote_fingerprint) {
      throw new ReconciliationConflictError("This interface changed on the MikroTik after the last synchronization.", remote);
    }
    await client.updateInterface(remote.id, { name: input.name, listenPort: input.listenPort, mtu: input.mtu, disabled: input.disabled });
    const updated = (await client.getInterfaces()).find((item) => item.id === remote.id);
    if (!updated) throw new Error("RouterOS did not return the interface during verification.");
    await query(
      `UPDATE wireguard_interfaces SET name=$2,listen_port=$3,mtu=$4,disabled=$5,client_pool_start=$6,
       client_pool_end=$7,default_dns=$8,default_allowed_ips=$9,remote_fingerprint=$10,updated_at=now() WHERE id=$1`,
      [id,input.name,input.listenPort,input.mtu,input.disabled,input.clientPoolStart || null,input.clientPoolEnd || null,
        input.defaultDns,input.defaultAllowedIps,remoteInterfaceFingerprint(updated)],
    );
  } finally { await client.close(); }
}

export async function createInterface(routerId: string, input: InterfaceInput) {
  const router = await getRouter(routerId);
  const client = clientForRouter(router);
  let remoteId: string | null = null;
  try {
    remoteId = await client.createInterface({ name: input.name, listenPort: input.listenPort, mtu: input.mtu, disabled: input.disabled });
    const remote = (await client.getInterfaces()).find((item) => item.id === remoteId || item.name === input.name);
    if (!remote) throw new Error("RouterOS created the interface but did not return it during verification.");
    const result = await query<{ id: string }>(
      `INSERT INTO wireguard_interfaces(router_id,remote_id,name,listen_port,mtu,public_key,running,disabled,
       client_pool_start,client_pool_end,default_dns,default_allowed_ips,remote_fingerprint)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [routerId,remote.id,remote.name,remote.listenPort,remote.mtu,remote.publicKey,remote.running,remote.disabled,
        input.clientPoolStart || null,input.clientPoolEnd || null,input.defaultDns,input.defaultAllowedIps,remoteInterfaceFingerprint(remote)],
    );
    return result.rows[0].id;
  } catch (error) {
    if (remoteId) {
      // Interface deletion is intentionally not automatic: it may have gained peers between create and DB failure.
    }
    throw error;
  } finally { await client.close(); }
}

async function getInterface(id: string) {
  const result = await query<InterfaceRow>("SELECT id,router_id,remote_id,remote_fingerprint FROM wireguard_interfaces WHERE id=$1", [id]);
  if (!result.rows[0]) throw new Error("WireGuard interface not found.");
  return result.rows[0];
}
