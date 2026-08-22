import type { PoolClient } from "pg";
import { query,withTransaction } from "@/lib/db";
import { allowedAddressOwnsIp,ipv4Range,ipv4ToNumber,normalizeClientIp,numberToIpv4,parseIpv4Cidr,suggestPoolFromInterfaceAddress,validatePoolRange,IpAllocationError } from "./ip-allocation";
import type { RemoteWireGuardPeer } from "./routeros";
import { compareIpAddresses } from "@/lib/ip-sort";

export const MAX_POOL_ADDRESSES=65_536;

export type WireGuardPool={
  id:string;name:string;router_id:string;interface_id:string;network_cidr:string;gateway_ip:string;start_ip:string;end_ip:string;
  dns:string;client_allowed_ips:string;endpoint_host:string|null;endpoint_port:number|null;mtu:number;persistent_keepalive:number;enabled:boolean;
  router_name?:string;interface_name?:string;interface_addresses?:string[];
};

export type PoolInput={
  name:string;routerId:string;interfaceId:string;networkCidr:string;gatewayIp:string;startIp:string;endIp:string;dns:string;
  clientAllowedIps:string;endpointHost?:string|null;endpointPort?:number|null;mtu:number;persistentKeepalive:number;enabled:boolean;userId?:string;
};

export class PoolConflictError extends IpAllocationError {
  constructor(message:string,public readonly owner?:{peer?:string;router?:string;interface?:string;kind?:string}){super(message);this.name="PoolConflictError"}
}

type InterfaceScope={id:string;router_id:string;name:string;addresses:string[];router_name:string;endpoint_hostname:string|null;endpoint_ip:string|null;management_ip:string;wireguard_port:number|null;listen_port:number};

export async function createPool(input:PoolInput){
  const normalized=normalizePoolInput(input);
  return withTransaction(async db=>{
    await lockRouterScope(db,input.routerId);
    const scope=await interfaceScope(db,input.routerId,input.interfaceId);
    validateScope(scope,normalized);
    await assertNoOverlap(db,input.routerId,normalized.startIp,normalized.endIp);
    const result=await db.query<{id:string}>(`INSERT INTO wireguard_pools(name,router_id,interface_id,network_cidr,gateway_ip,start_ip,end_ip,dns,
      client_allowed_ips,endpoint_host,endpoint_port,mtu,persistent_keepalive,enabled,created_by)
      VALUES($1,$2,$3,$4::cidr,$5::inet,$6::inet,$7::inet,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [normalized.name,input.routerId,input.interfaceId,normalized.networkCidr,normalized.gatewayIp,normalized.startIp,normalized.endIp,normalized.dns,
        normalized.clientAllowedIps,normalized.endpointHost,normalized.endpointPort,normalized.mtu,normalized.persistentKeepalive,normalized.enabled,input.userId??null]);
    const id=result.rows[0].id;
    await db.query(`INSERT INTO wireguard_pool_addresses(pool_id,router_id,interface_id,ip_address,state,comment)
      VALUES($1,$2,$3,$4::inet,'router','WireGuard interface address') ON CONFLICT(router_id,ip_address) DO NOTHING`,[id,input.routerId,input.interfaceId,normalized.gatewayIp]);
    await attachExistingPeers(db,id,input.routerId,input.interfaceId,normalized.startIp,normalized.endIp);
    return id;
  });
}

export async function updatePool(id:string,input:PoolInput){
  const normalized=normalizePoolInput(input);
  return withTransaction(async db=>{
    const current=await lockPool(db,id);
    if(current.router_id!==input.routerId)throw new PoolConflictError("A pool cannot be moved to another router. Create a new pool instead.");
    if(current.interface_id!==input.interfaceId)throw new PoolConflictError("A pool cannot be moved to another WireGuard interface. Create a new pool instead.");
    await lockRouterScope(db,input.routerId);
    const scope=await interfaceScope(db,input.routerId,input.interfaceId);
    validateScope(scope,normalized);
    await assertNoOverlap(db,input.routerId,normalized.startIp,normalized.endIp,id);
    const occupied=await db.query<{ip_address:string;state:string;comment:string|null}>(`SELECT host(ip_address) ip_address,state,comment FROM wireguard_pool_addresses
      WHERE pool_id=$1 AND state IN ('reserved','allocated') AND (ip_address<$2::inet OR ip_address>$3::inet)`,[id,normalized.startIp,normalized.endIp]);
    if(occupied.rows[0])throw new PoolConflictError(`Cannot shrink this pool: ${occupied.rows[0].ip_address} is ${occupied.rows[0].state}.`);
    await db.query(`UPDATE wireguard_pools SET name=$2,interface_id=$3,network_cidr=$4::cidr,gateway_ip=$5::inet,start_ip=$6::inet,end_ip=$7::inet,
      dns=$8,client_allowed_ips=$9,endpoint_host=$10,endpoint_port=$11,mtu=$12,persistent_keepalive=$13,enabled=$14,updated_at=now() WHERE id=$1`,
      [id,normalized.name,input.interfaceId,normalized.networkCidr,normalized.gatewayIp,normalized.startIp,normalized.endIp,normalized.dns,
        normalized.clientAllowedIps,normalized.endpointHost,normalized.endpointPort,normalized.mtu,normalized.persistentKeepalive,normalized.enabled]);
    await db.query("DELETE FROM wireguard_pool_addresses WHERE pool_id=$1 AND state='router'",[id]);
    await db.query(`INSERT INTO wireguard_pool_addresses(pool_id,router_id,interface_id,ip_address,state,comment)
      VALUES($1,$2,$3,$4::inet,'router','WireGuard interface address') ON CONFLICT(router_id,ip_address) DO NOTHING`,[id,input.routerId,input.interfaceId,normalized.gatewayIp]);
    await attachExistingPeers(db,id,input.routerId,input.interfaceId,normalized.startIp,normalized.endIp);
  });
}

export async function deletePool(id:string){
  return withTransaction(async db=>{
    const pool=await lockPool(db,id);
    const usage=await db.query<{peers:string;reserved:string}>(`SELECT
      (SELECT count(*) FROM peers WHERE pool_id=$1)::text peers,
      (SELECT count(*) FROM wireguard_pool_addresses WHERE pool_id=$1 AND state='reserved')::text reserved`,[id]);
    if(Number(usage.rows[0].peers)>0)throw new PoolConflictError("Move or delete every peer assigned by this pool before deleting it.");
    if(Number(usage.rows[0].reserved)>0)throw new PoolConflictError("Remove this pool's reserved addresses before deleting it.");
    await db.query("DELETE FROM wireguard_pools WHERE id=$1",[pool.id]);
  });
}

export async function reservePoolAddress(poolId:string,ipAddress:string,comment:string){
  return withTransaction(async db=>{
    const pool=await lockPool(db,poolId);const ip=validateAddressInPool(pool,ipAddress);
    await assertDatabaseAddressFree(db,pool,ip);
    await db.query(`INSERT INTO wireguard_pool_addresses(pool_id,router_id,interface_id,ip_address,state,comment)
      VALUES($1,$2,$3,$4::inet,'reserved',$5)`,[pool.id,pool.router_id,pool.interface_id,ip,comment]);
  });
}

export async function unreservePoolAddress(poolId:string,ipAddress:string){
  const result=await query("DELETE FROM wireguard_pool_addresses WHERE pool_id=$1 AND ip_address=$2::inet AND state='reserved'",[poolId,normalizeClientIp(ipAddress)]);
  if(!result.rowCount)throw new PoolConflictError("That address is not a reservation in this pool.");
}

export async function getPool(id:string){
  const result=await query<WireGuardPool>(`SELECT p.*,host(p.gateway_ip) gateway_ip,host(p.start_ip) start_ip,host(p.end_ip) end_ip,
    r.name router_name,i.name interface_name,i.addresses interface_addresses FROM wireguard_pools p
    JOIN routers r ON r.id=p.router_id JOIN wireguard_interfaces i ON i.id=p.interface_id WHERE p.id=$1`,[id]);
  if(!result.rows[0])throw new PoolConflictError("WireGuard pool not found.");return result.rows[0];
}

export async function getPoolStats(poolId:string){
  const pool=await getPool(poolId);const range=ipv4Range(pool.start_ip,pool.end_ip);
  const counts=await query<{used:string;reserved:string}>(`SELECT count(*) FILTER(WHERE state='allocated')::text used,
    count(*) FILTER(WHERE state='reserved')::text reserved FROM wireguard_pool_addresses WHERE pool_id=$1`,[poolId]);
  const used=Number(counts.rows[0].used);const reserved=Number(counts.rows[0].reserved);
  return{total:range.total,used,reserved,available:Math.max(0,range.total-used-reserved)};
}

export type AddressView={ip:string;state:"available"|"used"|"imported"|"reserved"|"router";owner:string|null;comment:string|null};
export async function listPoolAddresses(poolId:string,options:{filter?:string;sort?:string;page?:number;limit?:number}={}){
  const pool=await getPool(poolId);const stored=await query<{ip:string;state:string;comment:string|null;peer_name:string|null;origin:string|null}>(`SELECT host(a.ip_address) ip,a.state,a.comment,p.name peer_name,p.origin
    FROM wireguard_pool_addresses a LEFT JOIN peers p ON p.id=a.peer_id WHERE a.pool_id=$1`,[poolId]);
  const byIp=new Map(stored.rows.map(row=>[row.ip,row]));const range=ipv4Range(pool.start_ip,pool.end_ip);const rows:AddressView[]=[];
  for(let value=range.start;value<=range.end;value+=1){const ip=numberToIpv4(value);const row=byIp.get(ip);rows.push(row?addressView(row):{ip,state:"available",owner:null,comment:null});}
  if(!rows.some(row=>row.ip===normalizeClientIp(pool.gateway_ip)))rows.push({ip:normalizeClientIp(pool.gateway_ip),state:"router",owner:pool.interface_name??"Router",comment:"WireGuard interface address"});
  const filter=options.filter??"all";let filtered=filter==="all"?rows:rows.filter(row=>row.state===filter);
  const [field="ip",direction="asc"]=(options.sort??"ip_asc").split("_");const factor=direction==="desc"?-1:1;
  filtered=filtered.sort((a,b)=>factor*(field==="state"?a.state.localeCompare(b.state):field==="owner"?(a.owner??"").localeCompare(b.owner??""):compareIpAddresses(a.ip,b.ip)));
  const page=Math.max(1,options.page??1);const limit=Math.min(250,Math.max(25,options.limit??100));
  return{pool,rows:filtered.slice((page-1)*limit,page*limit),total:filtered.length,page,pages:Math.max(1,Math.ceil(filtered.length/limit)),stats:await getPoolStats(poolId)};
}

export async function poolSuggestionsForInterface(interfaceId:string){
  const result=await query<{address:string}>("SELECT unnest(addresses) address FROM wireguard_interfaces WHERE id=$1",[interfaceId]);
  return result.rows.flatMap(row=>{try{const suggestion=suggestPoolFromInterfaceAddress(row.address);return suggestion?[suggestion]:[]}catch{return[]}});
}

export async function lockPoolForPeer(db:PoolClient,poolId:string,routerId:string,interfaceId:string){
  const pool=await lockPool(db,poolId);if(pool.router_id!==routerId||pool.interface_id!==interfaceId)throw new PoolConflictError("The selected pool does not belong to the selected router and WireGuard interface.");
  if(!pool.enabled)throw new PoolConflictError("The selected WireGuard pool is disabled.");return pool;
}

export async function choosePoolAddress(db:PoolClient,pool:WireGuardPool,remotePeers:RemoteWireGuardPeer[],requestedIp?:string,excludePeerId?:string){
  const owners=await db.query<{id:string;client_ip:string;name:string;router_name:string;interface_name:string}>(`SELECT p.id,p.client_ip,p.name,r.name router_name,i.name interface_name FROM peers p
    JOIN routers r ON r.id=p.router_id JOIN wireguard_interfaces i ON i.id=p.interface_id
    WHERE p.router_id=$1 AND p.client_ip IS NOT NULL AND ($2::uuid IS NULL OR p.id<>$2::uuid)`,[pool.router_id,excludePeerId??null]);
  const blocked=await db.query<{ip:string;state:string;comment:string|null}>(`SELECT host(ip_address) ip,state,comment FROM wireguard_pool_addresses
    WHERE router_id=$1 AND state IN ('reserved','allocated','router') AND ($2::uuid IS NULL OR peer_id IS DISTINCT FROM $2::uuid)`,[pool.router_id,excludePeerId??null]);
  const explain=(ip:string)=>{
    const dbOwner=owners.rows.find(owner=>normalizeClientIp(owner.client_ip)===ip);if(dbOwner)return new PoolConflictError(conflictMessage(ip,{peer:dbOwner.name,router:dbOwner.router_name,interface:dbOwner.interface_name}),{peer:dbOwner.name,router:dbOwner.router_name,interface:dbOwner.interface_name,kind:"peer"});
    const reservation=blocked.rows.find(row=>row.ip===ip);if(reservation)return new PoolConflictError(`Cannot use ${ip}\n\nThis address is ${reservation.state}: ${reservation.comment??reservation.state}.`,{kind:reservation.state});
    const remote=remotePeers.find(peer=>allowedAddressOwnsIp(peer.allowedAddress,ip));if(remote)return new PoolConflictError(conflictMessage(ip,{peer:remote.comment||remote.name||"Existing MikroTik peer",router:pool.router_name??"Selected MikroTik",interface:remote.interfaceName}),{peer:remote.comment||remote.name,router:pool.router_name,interface:remote.interfaceName,kind:"mikrotik_peer"});
    return null;
  };
  if(requestedIp){const ip=validateAddressInPool(pool,requestedIp);const conflict=explain(ip);if(conflict)throw conflict;return ip;}
  const range=ipv4Range(pool.start_ip,pool.end_ip);for(let value=range.start;value<=range.end;value+=1){const ip=numberToIpv4(value);if(!explain(ip))return ip;}
  throw new PoolConflictError(`No addresses are available in ${pool.name}.`);
}

export async function claimPoolAddress(db:PoolClient,pool:WireGuardPool,ip:string,peerId:string,peerName:string){
  await db.query("DELETE FROM wireguard_pool_addresses WHERE pool_id=$1 AND ip_address=$2::inet AND state='available'",[pool.id,ip]);
  await db.query(`INSERT INTO wireguard_pool_addresses(pool_id,router_id,interface_id,ip_address,state,peer_id,comment)
    VALUES($1,$2,$3,$4::inet,'allocated',$5,$6)`,[pool.id,pool.router_id,pool.interface_id,ip,peerId,peerName]);
}

export async function releasePeerPoolAddress(db:PoolClient,peerId:string){await db.query("DELETE FROM wireguard_pool_addresses WHERE peer_id=$1",[peerId])}

function normalizePoolInput(input:PoolInput){const valid=validatePoolRange(input.networkCidr,input.gatewayIp,input.startIp,input.endIp);if(valid.range.total>MAX_POOL_ADDRESSES)throw new IpAllocationError(`A pool range can contain at most ${MAX_POOL_ADDRESSES.toLocaleString()} IPv4 addresses.`);return{
  name:input.name.trim(),networkCidr:valid.network.cidr,gatewayIp:valid.gateway,startIp:numberToIpv4(valid.range.start),endIp:numberToIpv4(valid.range.end),dns:input.dns.trim(),clientAllowedIps:input.clientAllowedIps.trim(),
  endpointHost:input.endpointHost?.trim()||null,endpointPort:input.endpointPort??null,mtu:input.mtu,persistentKeepalive:input.persistentKeepalive,enabled:input.enabled};}
function validateScope(scope:InterfaceScope,pool:ReturnType<typeof normalizePoolInput>){const network=parseIpv4Cidr(pool.networkCidr);const matching=scope.addresses.find(address=>{try{return normalizeClientIp(address)===pool.gatewayIp&&parseIpv4Cidr(address).cidr===network.cidr}catch{return false}});if(scope.addresses.length&&!matching)throw new PoolConflictError(`Gateway ${pool.gatewayIp} with network ${network.cidr} is not assigned to ${scope.name}. Synchronize the router or select its actual WireGuard address.`)}
async function interfaceScope(db:PoolClient,routerId:string,interfaceId:string){const result=await db.query<InterfaceScope>(`SELECT i.id,i.router_id,i.name,i.addresses,r.name router_name,r.endpoint_hostname,r.endpoint_ip,r.management_ip,r.wireguard_port,i.listen_port
  FROM wireguard_interfaces i JOIN routers r ON r.id=i.router_id WHERE i.id=$1 AND i.router_id=$2`,[interfaceId,routerId]);if(!result.rows[0])throw new PoolConflictError("The selected WireGuard interface does not belong to the selected router.");return result.rows[0]}
async function lockRouterScope(db:PoolClient,routerId:string){await db.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`wireguard-pool:${routerId}`])}
async function lockPool(db:PoolClient,id:string){const result=await db.query<WireGuardPool>(`SELECT p.*,host(gateway_ip) gateway_ip,host(start_ip) start_ip,host(end_ip) end_ip,r.name router_name,i.name interface_name
  FROM wireguard_pools p JOIN routers r ON r.id=p.router_id JOIN wireguard_interfaces i ON i.id=p.interface_id WHERE p.id=$1 FOR UPDATE OF p`,[id]);if(!result.rows[0])throw new PoolConflictError("WireGuard pool not found.");return result.rows[0]}
async function assertNoOverlap(db:PoolClient,routerId:string,start:string,end:string,excludeId?:string){const result=await db.query<{name:string;start_ip:string;end_ip:string}>(`SELECT name,host(start_ip) start_ip,host(end_ip) end_ip FROM wireguard_pools
  WHERE router_id=$1 AND ($4::uuid IS NULL OR id<>$4::uuid) AND NOT (end_ip<$2::inet OR start_ip>$3::inet) LIMIT 1`,[routerId,start,end,excludeId??null]);if(result.rows[0])throw new PoolConflictError(`This range overlaps ${result.rows[0].name} (${result.rows[0].start_ip} – ${result.rows[0].end_ip}) on the same router.`)}
async function attachExistingPeers(db:PoolClient,poolId:string,routerId:string,interfaceId:string,start:string,end:string){const peers=await db.query<{id:string;name:string;client_ip:string}>(`SELECT id,name,client_ip FROM peers WHERE router_id=$1 AND interface_id=$2 AND client_ip::inet BETWEEN $3::inet AND $4::inet`,[routerId,interfaceId,start,end]);for(const peer of peers.rows){await db.query("UPDATE peers SET pool_id=COALESCE(pool_id,$2) WHERE id=$1",[peer.id,poolId]);await db.query(`INSERT INTO wireguard_pool_addresses(pool_id,router_id,interface_id,ip_address,state,peer_id,comment)
    VALUES($1,$2,$3,$4::inet,'allocated',$5,$6) ON CONFLICT(router_id,ip_address) DO NOTHING`,[poolId,routerId,interfaceId,peer.client_ip,peer.id,peer.name])}}
async function assertDatabaseAddressFree(db:PoolClient,pool:WireGuardPool,ip:string){const peer=await db.query<{name:string;router_name:string;interface_name:string}>(`SELECT p.name,r.name router_name,i.name interface_name FROM peers p JOIN routers r ON r.id=p.router_id JOIN wireguard_interfaces i ON i.id=p.interface_id WHERE p.router_id=$1 AND p.client_ip=$2 LIMIT 1`,[pool.router_id,ip]);if(peer.rows[0])throw new PoolConflictError(conflictMessage(ip,{peer:peer.rows[0].name,router:peer.rows[0].router_name,interface:peer.rows[0].interface_name}));const row=await db.query<{state:string;comment:string|null}>("SELECT state,comment FROM wireguard_pool_addresses WHERE router_id=$1 AND ip_address=$2::inet",[pool.router_id,ip]);if(row.rows[0])throw new PoolConflictError(`Cannot reserve ${ip}: it is ${row.rows[0].state}${row.rows[0].comment?` (${row.rows[0].comment})`:""}.`)}
function validateAddressInPool(pool:WireGuardPool,value:string){const ip=normalizeClientIp(value);const number=ipv4ToNumber(ip);const range=ipv4Range(pool.start_ip,pool.end_ip);if(number<range.start||number>range.end)throw new PoolConflictError(`${ip} is outside ${pool.name} (${pool.start_ip} – ${pool.end_ip}).`);if(ip===normalizeClientIp(pool.gateway_ip))throw new PoolConflictError(`${ip} is the router/interface address.`);return ip}
function conflictMessage(ip:string,owner:{peer?:string;router?:string;interface?:string}){return`Cannot use ${ip}\n\nThis address is already assigned to:\n\nPeer: ${owner.peer??"Unknown peer"}\nRouter: ${owner.router??"Unknown router"}\nInterface: ${owner.interface??"Unknown interface"}`}
function addressView(row:{ip:string;state:string;comment:string|null;peer_name:string|null;origin:string|null}):AddressView{if(row.state==="allocated")return{ip:row.ip,state:row.origin==="imported"?"imported":"used",owner:row.peer_name,comment:row.comment};return{ip:row.ip,state:row.state as AddressView["state"],owner:row.state==="router"?"Router":null,comment:row.comment}}
