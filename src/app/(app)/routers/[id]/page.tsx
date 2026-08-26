import { notFound } from "next/navigation";
import Link from "next/link";
import { Download, Network } from "lucide-react";
import { query } from "@/lib/db";
import { can, getSession } from "@/lib/auth";
import { decryptSecret } from "@/lib/security";
import { PageHeader,StatusBadge } from "@/components/ui";
import { RouterForm } from "@/components/router-form";
import { RouterDefaultsForm } from "@/components/router-defaults-form";
import { SyncRouterButton } from "@/components/router-actions";
import type { RouterRow } from "@/server/router-repository";
import { suggestPoolFromInterfaceAddress } from "@/server/ip-allocation";

type Detail=RouterRow&{connection_status:string;stats_poll_status:string;identity:string|null;routeros_version:string|null;architecture:string|null;board_name:string|null;uptime:string|null;last_error:string|null;last_checked_at:Date|null;last_synced_at:Date|null;last_stats_poll_at:Date|null;last_stats_success_at:Date|null;last_stats_error:string|null};
type InterfaceRow={id:string;name:string;addresses:string[];pools:string;peers:string};
type PoolRow={id:string;name:string;interface_id:string};

export default async function RouterDetailPage({params}:{params:Promise<{id:string}>}){
  const[{id},session]=await Promise.all([params,getSession()]);
  const[routerResult,interfaces,pools]=await Promise.all([
    query<Detail>("SELECT * FROM routers WHERE id=$1",[id]),
    query<InterfaceRow>(`SELECT i.id,i.name,i.addresses,count(DISTINCT wp.id)::text pools,count(DISTINCT p.id)::text peers
      FROM wireguard_interfaces i LEFT JOIN wireguard_pools wp ON wp.interface_id=i.id LEFT JOIN peers p ON p.interface_id=i.id
      WHERE i.router_id=$1 GROUP BY i.id ORDER BY i.name`,[id]),
    query<PoolRow>("SELECT id,name,interface_id FROM wireguard_pools WHERE router_id=$1 AND enabled ORDER BY name",[id]),
  ]);
  const router=routerResult.rows[0];if(!router)notFound();
  const manage=Boolean(session&&can(session,"router:manage"));
  const initial={id:router.id,name:router.name,managementIp:router.management_ip,apiPort:router.api_port,apiType:router.api_type,username:manage?decryptSecret(router.username_encrypted):"",endpointHostname:router.endpoint_hostname||"",endpointIp:router.endpoint_ip||"",wireguardPort:router.wireguard_port||51820,useTls:router.use_tls,verifyTls:router.verify_tls,enabled:router.enabled};
  return <><PageHeader title={router.name} description={`${router.identity||router.management_ip} · RouterOS ${router.routeros_version||"unknown"}`} actions={<><StatusBadge status={router.stats_poll_status==="unreachable"?"router_unreachable":router.connection_status}/>{manage&&<><a className="button" href={`/api/routers/${id}/snapshot`}><Download/>Export snapshot</a><SyncRouterButton id={id}/></>}</>}/>
    <div className="grid-sidebar"><section className="card"><div className="card-header"><h2>Connection & endpoint</h2></div><div className="card-body">{manage?<RouterForm initial={initial}/>:<dl className="detail-list"><dt>Management address</dt><dd>{router.management_ip}:{router.api_port}</dd><dt>API</dt><dd>{router.api_type.toUpperCase()}</dd><dt>WireGuard endpoint</dt><dd>{router.endpoint_hostname||router.endpoint_ip||router.management_ip}:{router.wireguard_port||51820}</dd><dt>TLS verification</dt><dd>{router.use_tls?(router.verify_tls?"Enabled":"TLS enabled; certificate verification disabled"):"Not enabled"}</dd></dl>}</div></section><aside className="card"><div className="card-header"><h2>Observed system</h2></div><div className="card-body"><dl className="detail-list"><dt>Identity</dt><dd>{router.identity||"—"}</dd><dt>Version</dt><dd>{router.routeros_version||"—"}</dd><dt>Architecture</dt><dd>{router.architecture||"—"}</dd><dt>Board</dt><dd>{router.board_name||"—"}</dd><dt>Uptime</dt><dd>{router.uptime||"—"}</dd><dt>Last checked</dt><dd>{router.last_checked_at?new Date(router.last_checked_at).toLocaleString():"never"}</dd><dt>Last sync</dt><dd>{router.last_synced_at?new Date(router.last_synced_at).toLocaleString():"never"}</dd><dt>Last statistics poll</dt><dd>{router.last_stats_poll_at?new Date(router.last_stats_poll_at).toLocaleString():"never"}</dd><dt>Last successful statistics poll</dt><dd>{router.last_stats_success_at?new Date(router.last_stats_success_at).toLocaleString():"never"}</dd></dl>{(router.last_stats_error||router.last_error)&&<div className="form-message form-message-error">{router.last_stats_error||router.last_error}</div>}</div></aside></div>
    <section className="card" style={{marginTop:16}}><div className="card-header"><div><h2>Router defaults</h2><p>Pre-populates new peers; explicit peer and profile values retain higher precedence.</p></div></div><div className="card-body">{manage?<RouterDefaultsForm routerId={id} interfaces={interfaces.rows.map(item=>({id:item.id,name:item.name}))} pools={pools.rows.map(item=>({id:item.id,name:item.name,interfaceId:item.interface_id}))} initial={{interfaceId:router.default_interface_id,poolId:router.default_pool_id,dns:router.default_dns,allowedIps:router.default_client_allowed_ips,endpoint:router.default_endpoint,mtu:router.default_mtu,keepalive:router.default_persistent_keepalive,quotaBytes:router.default_quota_bytes,quotaPeriod:router.default_quota_period,bandwidthMode:router.default_bandwidth_mode,downloadBps:router.default_download_bps,uploadBps:router.default_upload_bps,expirationDays:router.default_expiration_days}}/>:<p className="cell-sub">Router defaults are read-only for your account.</p>}</div></section>
    <section className="card" style={{marginTop:16}}><div className="card-header"><h2>WireGuard interfaces and pool detection</h2><Link className="button button-small" href="/pools">Manage pools</Link></div><div className="card-body"><div className="router-grid">{interfaces.rows.map(item=>{const suggestion=item.addresses.flatMap(address=>{try{const value=suggestPoolFromInterfaceAddress(address);return value?[value]:[]}catch{return[]}})[0];return <article className="card router-card" key={item.id}><div className="router-card-top"><div><h3>{item.name}</h3><div className="router-meta">{item.addresses.join(", ")||"No address detected"}</div></div><Network/></div><div className="router-facts"><div className="router-fact"><strong>{item.peers}</strong><span>peers</span></div><div className="router-fact"><strong>{item.pools}</strong><span>pools</span></div></div>{suggestion?<div className="detected-pool"><strong>Detected {suggestion.network}</strong><span>Gateway {suggestion.gateway}</span><span>Suggested {suggestion.startIp} – {suggestion.endIp}</span><Link className="button button-small" href={`/pools?create=1&interface=${item.id}&suggest=1`}>Review and create</Link></div>:<p className="cell-sub">No usable IPv4 subnet was detected. Synchronize after assigning an address to the WireGuard interface.</p>}</article>})}</div></div></section>
  </>;
}
