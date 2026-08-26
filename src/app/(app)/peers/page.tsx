import { Filter, Plus, Search, UsersRound, Waypoints } from "lucide-react";
import { query } from "@/lib/db";
import { formatBytes } from "@/server/status";
import { getGlobalBandwidthDefaults, getStatusThresholds } from "@/server/settings";
import { EmptyState, PageHeader } from "@/components/ui";
import { PeerCreateDialog } from "@/components/peer-form";
import { PeerTable, type PeerTableRow } from "@/components/peer-table";
import Link from "next/link";
import { allocateClientIp } from "@/server/ip-allocation";
import { BulkPeerCreateDialog } from "@/components/bulk-peer-create";

type PeerRow={id:string;name:string;description:string|null;router_name:string;interface_name:string;client_ip:string|null;public_key:string;origin:string;status:string;last_handshake_at:Date|null;expires_at:Date|null;lifetime_rx_bytes:string;lifetime_tx_bytes:string;period_rx_bytes:string;period_tx_bytes:string;quota_limit_bytes:string|null;quota_period:"one_time"|"daily"|"weekly"|"monthly"|null;conflict_type:string|null;bandwidth_mode:string;bandwidth_source:string;bandwidth_sync_state:string;effective_download_bps:string|null;effective_upload_bps:string|null;total_count:string};
type SelectOption={id:string;name:string;default_interface_id:string|null;default_pool_id:string|null;default_dns:string|null;default_client_allowed_ips:string|null;default_endpoint:string|null;default_mtu:number|null;default_persistent_keepalive:number|null;default_quota_bytes:string|null;default_quota_period:string|null;default_bandwidth_mode:"global"|"unlimited"|"custom";default_download_bps:string|null;default_upload_bps:string|null;default_expiration_days:number|null};
type InterfaceOption={id:string;name:string;router_id:string;router_name:string;addresses:string[]};
type PoolOption={id:string;name:string;router_id:string;interface_id:string;network_cidr:string;start_ip:string;end_ip:string;dns:string;client_allowed_ips:string;endpoint_host:string|null;endpoint_port:number|null;mtu:number;persistent_keepalive:number;enabled:boolean;total:string;occupied:string;used_addresses:string[]};
type ProfileOption={id:string;name:string;description:string|null;pool_id:string|null;dns:string|null;client_allowed_ips:string|null;mtu:number|null;persistent_keepalive:number|null;quota_limit_bytes:string|null;quota_period:string|null;bandwidth_profile_id:string|null;expiration_days:number|null};
type BandwidthProfileOption={id:string;name:string;download_bps:string|null;upload_bps:string|null};
export const metadata={title:"WireGuard Peers"};

export default async function PeersPage({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}) {
  const p=await searchParams;
  const q=p.q||"";const routerId=p.router||"";const interfaceId=p.interface||"";const status=p.status||"";const origin=p.origin||"";const quota=p.quota||"";const bandwidth=p.bandwidth||"";const sort=p.sort||"name_asc";
  const page=Math.max(1,Number(p.page)||1);const limit=50;
  const orderBy:Record<string,string>={name_asc:"name ASC",name_desc:"name DESC",ip_asc:"client_ip::inet ASC NULLS LAST",ip_desc:"client_ip::inet DESC NULLS LAST",router_asc:"router_name ASC,name ASC",router_desc:"router_name DESC,name ASC",status_asc:"status ASC,name ASC",status_desc:"status DESC,name ASC",handshake_asc:"last_handshake_at ASC NULLS LAST",handshake_desc:"last_handshake_at DESC NULLS LAST",rx_asc:"lifetime_rx_bytes ASC",rx_desc:"lifetime_rx_bytes DESC",tx_asc:"lifetime_tx_bytes ASC",tx_desc:"lifetime_tx_bytes DESC",usage_desc:"(period_rx_bytes+period_tx_bytes) DESC,name ASC",usage_asc:"(period_rx_bytes+period_tx_bytes) ASC,name ASC",limit_asc:"quota_limit_bytes ASC NULLS LAST",limit_desc:"quota_limit_bytes DESC NULLS LAST",quota_desc:"CASE WHEN quota_limit_bytes IS NULL THEN -1 ELSE ((period_rx_bytes+period_tx_bytes)*10000/quota_limit_bytes) END DESC,name ASC",quota_asc:"CASE WHEN quota_limit_bytes IS NULL THEN 100000000 ELSE ((period_rx_bytes+period_tx_bytes)*10000/quota_limit_bytes) END ASC,name ASC",bandwidth_asc:"effective_download_bps ASC NULLS FIRST,name ASC",bandwidth_desc:"effective_download_bps DESC NULLS LAST,name ASC",expires_asc:"expires_at ASC NULLS LAST",expires_desc:"expires_at DESC NULLS LAST"};
  const order=orderBy[sort]||orderBy.name_asc;
  const thresholds=await getStatusThresholds();
  const [peers,routers,interfaces,pools,profiles,bandwidthProfiles,globalBandwidth]=await Promise.all([
    query<PeerRow>(`WITH filtered AS (
      SELECT p.id,p.name,p.description,p.client_ip,p.public_key,p.origin,p.last_handshake_at,p.expires_at,
       p.lifetime_rx_bytes,p.lifetime_tx_bytes,p.period_rx_bytes,p.period_tx_bytes,p.quota_limit_bytes,p.quota_period,p.conflict_type,p.bandwidth_mode,p.bandwidth_source,p.bandwidth_sync_state,
       CASE WHEN p.bandwidth_mode='unlimited' THEN NULL WHEN p.bandwidth_mode='custom' THEN p.download_limit_bps WHEN p.bandwidth_mode='profile' THEN bp.download_bps
        WHEN bpp.id IS NOT NULL THEN bpp.download_bps WHEN r.default_bandwidth_mode='custom' THEN r.default_download_bps WHEN r.default_bandwidth_mode='unlimited' THEN NULL ELSE NULLIF(g.value->>'downloadBps','')::bigint END effective_download_bps,
       CASE WHEN p.bandwidth_mode='unlimited' THEN NULL WHEN p.bandwidth_mode='custom' THEN p.upload_limit_bps WHEN p.bandwidth_mode='profile' THEN bp.upload_bps
        WHEN bpp.id IS NOT NULL THEN bpp.upload_bps WHEN r.default_bandwidth_mode='custom' THEN r.default_upload_bps WHEN r.default_bandwidth_mode='unlimited' THEN NULL ELSE NULLIF(g.value->>'uploadBps','')::bigint END effective_upload_bps,
       r.name router_name,i.name interface_name,
       CASE WHEN p.expired THEN 'expired' WHEN p.quota_reached_at IS NOT NULL THEN 'traffic_limit_reached' WHEN p.disabled OR p.remote_disabled THEN 'disabled' WHEN r.stats_poll_status='unreachable' THEN 'router_unreachable' WHEN p.last_handshake_at IS NULL THEN 'never'
        WHEN p.last_handshake_at > now()-make_interval(secs=>$6) THEN 'online' WHEN p.last_handshake_at > now()-make_interval(secs=>$7) THEN 'recent' ELSE 'offline' END status
      FROM peers p JOIN routers r ON r.id=p.router_id JOIN wireguard_interfaces i ON i.id=p.interface_id LEFT JOIN bandwidth_profiles bp ON bp.id=p.bandwidth_profile_id
       LEFT JOIN peer_profiles pp ON pp.id=p.profile_id LEFT JOIN bandwidth_profiles bpp ON bpp.id=pp.bandwidth_profile_id LEFT JOIN settings g ON g.key='bandwidth_defaults'
      WHERE ($1='' OR p.name ILIKE '%'||$1||'%' OR coalesce(p.client_ip,'') ILIKE '%'||$1||'%' OR p.public_key ILIKE '%'||$1||'%' OR r.name ILIKE '%'||$1||'%' OR coalesce(p.description,'') ILIKE '%'||$1||'%')
       AND ($2='' OR r.id::text=$2) AND ($3='' OR i.id::text=$3) AND ($4='' OR p.origin=$4)
       AND ($5='' OR ($5='near' AND p.quota_limit_bytes IS NOT NULL AND (p.period_rx_bytes+p.period_tx_bytes)*100 >= p.quota_limit_bytes*80 AND (p.period_rx_bytes+p.period_tx_bytes)<p.quota_limit_bytes)
        OR ($5='reached' AND p.quota_limit_bytes IS NOT NULL AND (p.period_rx_bytes+p.period_tx_bytes)>=p.quota_limit_bytes)
        OR ($5='unlimited' AND p.quota_limit_bytes IS NULL) OR p.quota_period=$5)
    ) SELECT *,count(*) OVER()::text total_count FROM filtered WHERE ($8='' OR status=$8) AND ($11='' OR ($11='unlimited' AND effective_download_bps IS NULL) OR ($11='default' AND bandwidth_mode='default') OR ($11='custom' AND bandwidth_mode='custom') OR ($11='profile' AND bandwidth_source='profile')) ORDER BY ${order} LIMIT $9 OFFSET $10`,
      [q,routerId,interfaceId,origin,quota,thresholds.onlineSeconds,thresholds.recentSeconds,status,limit,(page-1)*limit,bandwidth]),
    query<SelectOption>(`SELECT id,name,default_interface_id,default_pool_id,default_dns,default_client_allowed_ips,default_endpoint,default_mtu,
      default_persistent_keepalive,default_quota_bytes,default_quota_period,default_bandwidth_mode,default_download_bps,default_upload_bps,default_expiration_days FROM routers ORDER BY name`),
    query<InterfaceOption>(`SELECT i.id,i.name,i.router_id,r.name router_name,i.addresses FROM wireguard_interfaces i JOIN routers r ON r.id=i.router_id ORDER BY r.name,i.name`),
    query<PoolOption>(`SELECT p.id,p.name,p.router_id,p.interface_id,p.network_cidr,host(p.start_ip) start_ip,host(p.end_ip) end_ip,p.dns,p.client_allowed_ips,p.endpoint_host,p.endpoint_port,p.mtu,p.persistent_keepalive,p.enabled,
      ((p.end_ip-p.start_ip)+1)::text total,count(a.id) FILTER(WHERE a.state IN ('allocated','reserved'))::text occupied,
      coalesce(array_agg(host(a.ip_address)) FILTER(WHERE a.state IN ('allocated','reserved','router')),'{}') used_addresses
      FROM wireguard_pools p LEFT JOIN wireguard_pool_addresses a ON a.pool_id=p.id GROUP BY p.id ORDER BY p.name`),
    query<ProfileOption>("SELECT id,name,description,pool_id,dns,client_allowed_ips,mtu,persistent_keepalive,quota_limit_bytes,quota_period,bandwidth_profile_id,expiration_days FROM peer_profiles WHERE enabled ORDER BY name"),
    query<BandwidthProfileOption>("SELECT id,name,download_bps,upload_bps FROM bandwidth_profiles WHERE enabled ORDER BY system DESC,name"),
    getGlobalBandwidthDefaults(),
  ]);
  const rows:PeerTableRow[]=peers.rows.map(row=>{
    const usage=BigInt(row.period_rx_bytes)+BigInt(row.period_tx_bytes);
    return {...row,last_handshake_at:row.last_handshake_at?.toISOString()||null,expires_at:row.expires_at?.toISOString()||null,
      rx:formatBytes(row.lifetime_rx_bytes),tx:formatBytes(row.lifetime_tx_bytes),currentUsage:formatBytes(usage),periodUsageBytes:usage.toString(),
      quotaLimit:row.quota_limit_bytes?formatBytes(row.quota_limit_bytes):"Unlimited",quotaLimitBytes:row.quota_limit_bytes,quotaPeriod:row.quota_period,
      bandwidth:row.effective_download_bps&&row.effective_upload_bps?`${formatRate(row.effective_download_bps)} ↓ / ${formatRate(row.effective_upload_bps)} ↑`:"Unlimited",bandwidthMode:row.bandwidth_mode,bandwidthSource:row.bandwidth_source,bandwidthSyncState:row.bandwidth_sync_state};
  });
  const total=Number(peers.rows[0]?.total_count||0);const pages=Math.ceil(total/limit);const tableQuery=new URLSearchParams(Object.fromEntries(Object.entries(p).filter(([key,value])=>Boolean(value)&&!["sort","page","create","bulk"].includes(key))) as Record<string,string>).toString();
  return <>
    <PageHeader title="WireGuard Peers" description="Search, provision, reconcile, account for, and enforce traffic quotas across every peer." actions={<><Link href="/peers?bulk=1" className="button"><UsersRound/>Bulk create</Link><Link href="/peers?create=1" className="button button-primary"><Plus/>Create peer</Link></>}/>
    <section className="card"><form className="table-toolbar" method="get"><div className="search"><Search/><input name="q" defaultValue={q} placeholder="Search name, comment, IP, key, router…" aria-label="Search peers"/></div>
      <select name="router" defaultValue={routerId} aria-label="Filter by router"><option value="">All routers</option>{routers.rows.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select>
      <select name="interface" defaultValue={interfaceId} aria-label="Filter by interface"><option value="">All interfaces</option>{interfaces.rows.map(row=><option key={row.id} value={row.id}>{row.router_name} / {row.name}</option>)}</select>
      <select name="status" defaultValue={status} aria-label="Filter by status"><option value="">All statuses</option>{["online","recent","offline","never","disabled","expired","traffic_limit_reached","router_unreachable"].map(value=><option key={value} value={value}>{value.replaceAll("_"," ")}</option>)}</select>
      <select name="origin" defaultValue={origin} aria-label="Filter by origin"><option value="">Managed & imported</option><option value="managed">Managed</option><option value="imported">Imported</option></select>
      <select name="quota" defaultValue={quota} aria-label="Filter by traffic quota"><option value="">All quota policies</option><option value="near">Near limit (80%+)</option><option value="reached">Limit reached</option><option value="unlimited">Unlimited</option><option value="one_time">One-time / total</option><option value="daily">Daily limit</option><option value="weekly">Weekly limit</option><option value="monthly">Monthly limit</option></select>
      <select name="bandwidth" defaultValue={bandwidth} aria-label="Filter by bandwidth"><option value="">All bandwidth policies</option><option value="unlimited">Unlimited bandwidth</option><option value="default">Uses default</option><option value="custom">Custom bandwidth</option><option value="profile">Bandwidth profile</option></select>
      <select name="sort" defaultValue={sort} aria-label="Sort peers"><option value="name_asc">Name A–Z</option><option value="name_desc">Name Z–A</option><option value="usage_desc">Highest traffic usage</option><option value="usage_asc">Lowest traffic usage</option><option value="quota_desc">Highest quota percentage</option><option value="handshake_desc">Newest handshake</option><option value="handshake_asc">Oldest handshake</option></select>
      <button className="button button-small"><Filter/>Apply</button>
    </form>
    {rows.length
      ? <PeerTable rows={rows} sort={sort} queryString={tableQuery}/>
      : <EmptyState icon={Waypoints} title="No peers match" message="Change the filters, synchronize a router to import existing peers, or create a managed peer." action={<Link className="button button-primary" href="/peers?create=1">Create peer</Link>}/>
    }
    {pages>1&&<div className="table-toolbar" style={{justifyContent:"flex-end"}}><span className="cell-sub">Page {page} of {pages} · {total} peers</span>{page>1&&<a className="button button-small" href={`/peers?${new URLSearchParams({...Object.fromEntries(Object.entries(p).filter(([,value])=>value)),page:String(page-1)} as Record<string,string>)}`}>Previous</a>}{page<pages&&<a className="button button-small" href={`/peers?${new URLSearchParams({...Object.fromEntries(Object.entries(p).filter(([,value])=>value)),page:String(page+1)} as Record<string,string>)}`}>Next</a>}</div>}
    </section>
    {p.create==="1"&&<PeerCreateDialog routers={routers.rows.map(row=>({id:row.id,name:row.name,defaultInterfaceId:row.default_interface_id,defaultPoolId:row.default_pool_id,defaultDns:row.default_dns,defaultAllowedIps:row.default_client_allowed_ips,defaultEndpoint:row.default_endpoint,defaultMtu:row.default_mtu,defaultKeepalive:row.default_persistent_keepalive,defaultQuotaBytes:row.default_quota_bytes,defaultQuotaPeriod:row.default_quota_period,defaultBandwidthMode:row.default_bandwidth_mode,defaultDownloadBps:row.default_download_bps,defaultUploadBps:row.default_upload_bps,defaultExpirationDays:row.default_expiration_days}))} interfaces={interfaces.rows.map(row=>({id:row.id,name:row.name,routerId:row.router_id,routerName:row.router_name,addresses:row.addresses}))} pools={pools.rows.map(row=>{let nextIp:string|null=null;try{nextIp=allocateClientIp(row.start_ip,row.end_ip,row.used_addresses)}catch{}const total=Number(row.total),occupied=Number(row.occupied);return{id:row.id,name:row.name,routerId:row.router_id,interfaceId:row.interface_id,network:row.network_cidr,startIp:row.start_ip,endIp:row.end_ip,dns:row.dns,clientAllowedIps:row.client_allowed_ips,endpoint:row.endpoint_host?`${row.endpoint_host}:${row.endpoint_port||""}`:"",mtu:row.mtu,persistentKeepalive:row.persistent_keepalive,total,available:Math.max(0,total-occupied),nextIp,enabled:row.enabled}})} profiles={profiles.rows.map(row=>({id:row.id,name:row.name,description:row.description,poolId:row.pool_id,dns:row.dns,clientAllowedIps:row.client_allowed_ips,mtu:row.mtu,keepalive:row.persistent_keepalive,quotaBytes:row.quota_limit_bytes,quotaPeriod:row.quota_period,bandwidthProfileId:row.bandwidth_profile_id,expirationDays:row.expiration_days}))} bandwidthProfiles={bandwidthProfiles.rows.map(row=>({id:row.id,name:row.name,downloadBps:row.download_bps,uploadBps:row.upload_bps}))} globalBandwidth={globalBandwidth}/>} 
    {p.bulk==="1"&&<BulkPeerCreateDialog routers={routers.rows.map(row=>({id:row.id,name:row.name}))} interfaces={interfaces.rows.map(row=>({id:row.id,name:row.name,routerId:row.router_id}))} pools={pools.rows.filter(row=>row.enabled).map(row=>({id:row.id,name:row.name,routerId:row.router_id,interfaceId:row.interface_id,available:Math.max(0,Number(row.total)-Number(row.occupied))}))} profiles={profiles.rows.map(row=>({id:row.id,name:row.name}))}/>} 
  </>;
}

function formatRate(value:string){const amount=Number(value);return amount>=1e9?`${amount/1e9}G`:amount>=1e6?`${amount/1e6}M`:`${amount/1e3}K`}
