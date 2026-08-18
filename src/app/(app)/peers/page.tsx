import { Filter, Plus, Search, Waypoints } from "lucide-react";
import { query } from "@/lib/db";
import { formatBytes } from "@/server/status";
import { getStatusThresholds } from "@/server/settings";
import { EmptyState, PageHeader } from "@/components/ui";
import { PeerCreateDialog } from "@/components/peer-form";
import { PeerTable, type PeerTableRow } from "@/components/peer-table";
import Link from "next/link";

type PeerRow={id:string;name:string;description:string|null;router_name:string;interface_name:string;client_ip:string|null;public_key:string;origin:string;status:string;last_handshake_at:Date|null;rx_bytes:string;tx_bytes:string;conflict_type:string|null;total_count:string};
type SelectOption={id:string;name:string};
type InterfaceOption={id:string;name:string;router_id:string;router_name:string;default_dns:string;default_allowed_ips:string;mtu:number;client_pool_start:string|null;client_pool_end:string|null};
export const metadata={title:"WireGuard Peers"};
export default async function PeersPage({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}){const p=await searchParams;const q=p.q||"";const routerId=p.router||"";const interfaceId=p.interface||"";const status=p.status||"";const origin=p.origin||"";const page=Math.max(1,Number(p.page)||1);const limit=50;
 const thresholds=await getStatusThresholds();
 const [peers,routers,interfaces]=await Promise.all([
  query<PeerRow>(`WITH filtered AS (SELECT p.id,p.name,p.description,p.client_ip,p.public_key,p.origin,p.last_handshake_at,p.rx_bytes,p.tx_bytes,p.conflict_type,r.name router_name,i.name interface_name,
   CASE WHEN p.expired THEN 'expired' WHEN p.disabled THEN 'disabled' WHEN p.last_handshake_at IS NULL THEN 'never'
    WHEN p.last_handshake_at > now()-make_interval(secs=>$6) THEN 'online' WHEN p.last_handshake_at > now()-make_interval(secs=>$7) THEN 'recent' ELSE 'offline' END status
   FROM peers p JOIN routers r ON r.id=p.router_id JOIN wireguard_interfaces i ON i.id=p.interface_id
   WHERE ($1='' OR p.name ILIKE '%'||$1||'%' OR coalesce(p.client_ip,'') ILIKE '%'||$1||'%' OR p.public_key ILIKE '%'||$1||'%' OR r.name ILIKE '%'||$1||'%' OR coalesce(p.description,'') ILIKE '%'||$1||'%')
   AND ($2='' OR r.id::text=$2) AND ($3='' OR i.id::text=$3) AND ($4='' OR p.origin=$4))
   SELECT *,count(*) OVER()::text total_count FROM filtered WHERE ($5='' OR status=$5) ORDER BY name LIMIT $8 OFFSET $9`,
   [q,routerId,interfaceId,origin,status,thresholds.onlineSeconds,thresholds.recentSeconds,limit,(page-1)*limit]),
  query<SelectOption>("SELECT id,name FROM routers ORDER BY name"),
  query<InterfaceOption>(`SELECT i.id,i.name,i.router_id,r.name router_name,i.default_dns,i.default_allowed_ips,i.mtu,i.client_pool_start,i.client_pool_end FROM wireguard_interfaces i JOIN routers r ON r.id=i.router_id ORDER BY r.name,i.name`)
 ]);
 const rows:PeerTableRow[]=peers.rows.map(row=>({...row,last_handshake_at:row.last_handshake_at?.toISOString()||null,rx:formatBytes(row.rx_bytes),tx:formatBytes(row.tx_bytes),traffic:formatBytes(BigInt(row.rx_bytes)+BigInt(row.tx_bytes))}));const total=Number(peers.rows[0]?.total_count||0);const pages=Math.ceil(total/limit);
 return <><PageHeader title="WireGuard Peers" description="Search, reconcile, provision, export, and monitor every peer across your router estate." actions={<Link href="/peers?create=1" className="button button-primary"><Plus/>Create peer</Link>}/>
 <section className="card"><form className="table-toolbar" method="get"><div className="search"><Search/><input name="q" defaultValue={q} placeholder="Search name, IP, key, router, comment…" aria-label="Search peers"/></div><select name="router" defaultValue={routerId} aria-label="Filter by router"><option value="">All routers</option>{routers.rows.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select><select name="interface" defaultValue={interfaceId} aria-label="Filter by interface"><option value="">All interfaces</option>{interfaces.rows.map(i=><option key={i.id} value={i.id}>{i.router_name} / {i.name}</option>)}</select><select name="status" defaultValue={status} aria-label="Filter by status"><option value="">All statuses</option>{["online","recent","offline","never","disabled","expired"].map(v=><option key={v} value={v}>{v}</option>)}</select><select name="origin" defaultValue={origin} aria-label="Filter by origin"><option value="">Managed & imported</option><option value="managed">Managed</option><option value="imported">Imported</option></select><button className="button button-small"><Filter/>Apply</button></form>
 {rows.length?<PeerTable rows={rows}/>:<EmptyState icon={Waypoints} title="No peers match" message="Change the filters, synchronize a router to import existing peers, or create a managed peer." action={<Link className="button button-primary" href="/peers?create=1">Create peer</Link>}/>} {pages>1&&<div className="table-toolbar" style={{justifyContent:"flex-end"}}><span className="cell-sub">Page {page} of {pages} · {total} peers</span>{page>1&&<a className="button button-small" href={`/peers?${new URLSearchParams({...Object.fromEntries(Object.entries(p).filter(([,v])=>v)),page:String(page-1)} as Record<string,string>)}`}>Previous</a>}{page<pages&&<a className="button button-small" href={`/peers?${new URLSearchParams({...Object.fromEntries(Object.entries(p).filter(([,v])=>v)),page:String(page+1)} as Record<string,string>)}`}>Next</a>}</div>}
 </section>{p.create==="1"&&<PeerCreateDialog routers={routers.rows} interfaces={interfaces.rows.map(i=>({id:i.id,name:i.name,routerId:i.router_id,routerName:i.router_name,defaultDns:i.default_dns,defaultAllowedIps:i.default_allowed_ips,mtu:i.mtu,poolStart:i.client_pool_start,poolEnd:i.client_pool_end}))}/>}</>}
