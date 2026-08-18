import type { RemoteWireGuardPeer } from "./routeros";
import { remotePeerFingerprint } from "./routeros";

export type ReconciliationState="in_sync"|"router_only"|"db_only"|"modified_externally"|"disabled_externally"|"deleted_externally";
export function classifyPeerSync(local:{remoteId:string|null;remoteFingerprint:string|null;disabled:boolean}|null,remote:RemoteWireGuardPeer|null):ReconciliationState{
 if(!local&&remote)return"router_only";
 if(local&&!remote)return local.remoteId?"deleted_externally":"db_only";
 if(!local||!remote)return"db_only";
 if(!local.remoteFingerprint||local.remoteFingerprint===remotePeerFingerprint(remote))return"in_sync";
 return local.disabled!==remote.disabled?"disabled_externally":"modified_externally";
}
