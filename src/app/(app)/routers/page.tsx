import { Plus, Router as RouterIcon, ShieldCheck } from "lucide-react";
import { query } from "@/lib/db";
import { PageHeader, StatusBadge } from "@/components/ui";
import { RouterForm } from "@/components/router-form";
import { DeleteRouterButton, SyncRouterButton } from "@/components/router-actions";
import Link from "next/link";

type RouterRow={id:string;name:string;management_ip:string;api_port:number;api_type:string;use_tls:boolean;endpoint_hostname:string|null;endpoint_ip:string|null;connection_status:string;identity:string|null;routeros_version:string|null;board_name:string|null;last_error:string|null;last_checked_at:Date|null;last_synced_at:Date|null;interfaces:string;peers:string};
export const metadata={title:"Routers"};
export default async function RoutersPage({searchParams}:{searchParams:Promise<{add?:string}>}){const params=await searchParams;const result=await query<RouterRow>(`SELECT r.*,
 count(DISTINCT i.id)::text interfaces,count(DISTINCT p.id)::text peers FROM routers r
 LEFT JOIN wireguard_interfaces i ON i.router_id=r.id LEFT JOIN peers p ON p.router_id=r.id GROUP BY r.id ORDER BY r.name`);
 return <><PageHeader title="Routers" description="MikroTik management connections, endpoint identity, health, and synchronization." actions={<Link href="/routers?add=1" className="button button-primary"><Plus/>Add router</Link>}/>
 {result.rows.length?<div className="router-grid">{result.rows.map(r=><article className="card router-card" key={r.id}><div className="router-card-top"><div><h3><Link href={`/routers/${r.id}`}>{r.name}</Link></h3><div className="router-meta">{r.management_ip}:{r.api_port} · {r.api_type}{r.use_tls?"/TLS":""}</div></div><StatusBadge status={r.connection_status}/></div>
 <dl className="detail-list"><dt>Identity</dt><dd>{r.identity||"—"}</dd><dt>RouterOS / board</dt><dd>{r.routeros_version||"—"} · {r.board_name||"unknown"}</dd><dt>Endpoint</dt><dd className="mono">{r.endpoint_hostname||r.endpoint_ip||r.management_ip}</dd><dt>Inventory</dt><dd>{r.interfaces} interfaces · {r.peers} peers</dd></dl>
 {r.last_error&&<div className="form-message form-message-error">{r.last_error}</div>}<div className="actions" style={{marginTop:14}}><SyncRouterButton id={r.id}/><Link className="button button-small" href={`/routers/${r.id}`}>Manage</Link><DeleteRouterButton id={r.id} name={r.name}/></div></article>)}</div>:<div className="card empty"><RouterIcon/><h3>No routers yet</h3><p>Add a RouterOS v7 device. The connection is tested first, then interfaces and existing peers are imported without modification.</p><Link href="/routers?add=1" className="button button-primary"><Plus/>Add first router</Link></div>}
 <div className="card" style={{marginTop:16}}><div className="card-body" style={{display:"flex",gap:12,alignItems:"flex-start"}}><ShieldCheck color="var(--success)"/><div><strong>Management and endpoint addresses are separate</strong><div className="cell-sub">API traffic always uses the management IP. Generated client configurations prefer the endpoint hostname, then public endpoint IP, then management IP.</div></div></div></div>
 {params.add==="1"&&<RouterForm modal/>}</>}
