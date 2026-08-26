import { query, withTransaction } from "@/lib/db";
import { clientForRouter, getRouter } from "./router-repository";
import { deleteOwnedPeerQueueRemote, observePeerBandwidth } from "./bandwidth-service";
import { failOperation, finishOperation, operationStep } from "./operations";
import { releasePeerPoolAddress } from "./pool-service";
import { syncRouter } from "./sync";

type PendingOperation={id:string;operation_type:string;router_id:string|null;peer_id:string|null;context:Record<string,unknown>;status:string};
type CleanupPeer={id:string;router_id:string;interface_id:string;pool_id:string|null;remote_id:string|null;public_key:string;name:string;description:string|null;client_ip:string|null;created_at:Date;lifetime_rx_bytes:string;lifetime_tx_bytes:string};

export async function reconcilePendingOperations(limit=25){
  const operations=await query<PendingOperation>(`SELECT * FROM management_operations WHERE status IN ('partial','needs_reconciliation','pending_cleanup')
    AND (next_retry_at IS NULL OR next_retry_at<=now()) ORDER BY updated_at LIMIT $1`,[limit]);
  const totals={attempted:0,completed:0,pending:0};
  for(const operation of operations.rows){
    totals.attempted+=1;
    try{
      if(operation.operation_type==="peer_create")await reconcileCreateCleanup(operation);
      else if(operation.operation_type==="peer_delete")await reconcileDeleteCleanup(operation);
      else if(operation.operation_type==="peer_update")await reconcileUpdate(operation);
      else throw new Error(`No reconciler is registered for ${operation.operation_type}.`);
      totals.completed+=1;
    }catch(error){await failOperation(operation.id,error,operation.status==="pending_cleanup"?"pending_cleanup":"needs_reconciliation").catch(()=>undefined);totals.pending+=1}
  }
  return totals;
}

async function reconcileCreateCleanup(operation:PendingOperation){
  if(!operation.peer_id){await finishReconciledFailure(operation.id,{cleanupComplete:true,reason:"no staged peer"});return}
  const peer=(await query<CleanupPeer>("SELECT * FROM peers WHERE id=$1",[operation.peer_id])).rows[0];
  if(!peer){await finishReconciledFailure(operation.id,{cleanupComplete:true,reason:"staged peer already removed"});return}
  const client=clientForRouter(await getRouter(peer.router_id));
  try{
    await deleteOwnedPeerQueueRemote(client,peer.id);
    const remote=(await client.getPeers()).find((item)=>item.id===peer.remote_id||item.publicKey===peer.public_key);
    if(remote)await client.deletePeer(remote.id);
    const remains=(await client.getPeers()).some((item)=>item.id===peer.remote_id||item.publicKey===peer.public_key);
    if(remains)throw new Error("Peer cleanup could not be verified on RouterOS.");
    await withTransaction(async(db)=>{await releasePeerPoolAddress(db,peer.id);await db.query("DELETE FROM managed_router_objects WHERE peer_id=$1",[peer.id]);await db.query("DELETE FROM peers WHERE id=$1",[peer.id])});
    await operationStep(operation.id,"reconciliation_cleanup","succeeded");
    await finishReconciledFailure(operation.id,{cleanupComplete:true});
  }finally{await client.close()}
}

async function reconcileDeleteCleanup(operation:PendingOperation){
  if(!operation.peer_id){await finishOperation(operation.id,"completed",{cleanupComplete:true});return}
  const peer=(await query<CleanupPeer>("SELECT * FROM peers WHERE id=$1",[operation.peer_id])).rows[0];
  if(!peer){await finishOperation(operation.id,"completed",{cleanupComplete:true});return}
  const client=clientForRouter(await getRouter(peer.router_id));
  try{
    const remote=(await client.getPeers()).find((item)=>item.id===peer.remote_id||item.publicKey===peer.public_key);
    if(remote)await client.deletePeer(remote.id);
    if((await client.getPeers()).some((item)=>item.id===peer.remote_id||item.publicKey===peer.public_key))throw new Error("Peer deletion could not be verified on RouterOS.");
    const queuesRemoved=await deleteOwnedPeerQueueRemote(client,peer.id);
    await archiveAndDeletePeer(peer,queuesRemoved);
    await operationStep(operation.id,"reconciliation_cleanup","succeeded",{queuesRemoved});
    await finishOperation(operation.id,"completed",{cleanupComplete:true,queuesRemoved});
  }finally{await client.close()}
}

async function reconcileUpdate(operation:PendingOperation){
  if(!operation.router_id||!operation.peer_id)throw new Error("The update operation has incomplete reconciliation context.");
  await syncRouter(operation.router_id);
  await observePeerBandwidth(operation.peer_id);
  const peer=(await query<{sync_state:string;bandwidth_sync_state:string}>("SELECT sync_state,bandwidth_sync_state FROM peers WHERE id=$1",[operation.peer_id])).rows[0];
  if(!peer)throw new Error("Peer no longer exists.");
  if(peer.sync_state!=="synced"||!["synced","not_configured"].includes(peer.bandwidth_sync_state))throw new Error("Peer still has unresolved RouterOS drift.");
  await query("UPDATE peers SET lifecycle_status='active',updated_at=now() WHERE id=$1",[operation.peer_id]);
  await operationStep(operation.id,"reconciliation_observation","succeeded");
  await finishOperation(operation.id,"completed",{reconciled:true});
}

async function archiveAndDeletePeer(peer:CleanupPeer,queuesRemoved:number){
  await withTransaction(async(db)=>{
    const history=await db.query<{quota_history:unknown}>("SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.period_started_at),'[]'::jsonb) quota_history FROM quota_period_history q WHERE q.peer_id=$1",[peer.id]);
    await db.query(`INSERT INTO peer_archives(peer_id,router_id,interface_id,pool_id,name,description,client_ip,created_at,lifetime_rx_bytes,lifetime_tx_bytes,quota_history,deletion_details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[peer.id,peer.router_id,peer.interface_id,peer.pool_id,peer.name,peer.description,peer.client_ip,peer.created_at,
      peer.lifetime_rx_bytes,peer.lifetime_tx_bytes,JSON.stringify(history.rows[0]?.quota_history??[]),JSON.stringify({reconciled:true,queuesRemoved})]);
    await releasePeerPoolAddress(db,peer.id);await db.query("DELETE FROM managed_router_objects WHERE peer_id=$1",[peer.id]);await db.query("DELETE FROM peers WHERE id=$1",[peer.id]);
  });
}

async function finishReconciledFailure(operationId:string,context:Record<string,unknown>){
  await query("UPDATE management_operations SET status='failed',context=context||$2::jsonb,next_retry_at=NULL,finished_at=now(),updated_at=now() WHERE id=$1",[operationId,JSON.stringify(context)]);
}
