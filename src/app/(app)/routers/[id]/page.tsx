import { notFound } from "next/navigation";
import { query } from "@/lib/db";
import { decryptSecret } from "@/lib/security";
import { PageHeader, StatusBadge } from "@/components/ui";
import { RouterForm } from "@/components/router-form";
import { SyncRouterButton } from "@/components/router-actions";
import type { RouterRow } from "@/server/router-repository";

type Detail=RouterRow&{connection_status:string;identity:string|null;routeros_version:string|null;architecture:string|null;board_name:string|null;uptime:string|null;last_error:string|null;last_checked_at:Date|null;last_synced_at:Date|null};
export default async function RouterDetailPage({params}:{params:Promise<{id:string}>}){const {id}=await params;const router=(await query<Detail>("SELECT * FROM routers WHERE id=$1",[id])).rows[0];if(!router)notFound();
 const initial={id:router.id,name:router.name,managementIp:router.management_ip,apiPort:router.api_port,apiType:router.api_type,username:decryptSecret(router.username_encrypted),endpointHostname:router.endpoint_hostname||"",endpointIp:router.endpoint_ip||"",wireguardPort:router.wireguard_port||51820,useTls:router.use_tls,verifyTls:router.verify_tls,enabled:router.enabled};
 return <><PageHeader title={router.name} description={`${router.identity||router.management_ip} · RouterOS ${router.routeros_version||"unknown"}`} actions={<><StatusBadge status={router.connection_status}/><SyncRouterButton id={id}/></>}/>
 <div className="grid-sidebar"><section className="card"><div className="card-header"><h2>Connection & endpoint</h2></div><div className="card-body"><RouterForm initial={initial}/></div></section><aside className="card"><div className="card-header"><h2>Observed system</h2></div><div className="card-body"><dl className="detail-list"><dt>Identity</dt><dd>{router.identity||"—"}</dd><dt>Version</dt><dd>{router.routeros_version||"—"}</dd><dt>Architecture</dt><dd>{router.architecture||"—"}</dd><dt>Board</dt><dd>{router.board_name||"—"}</dd><dt>Uptime</dt><dd>{router.uptime||"—"}</dd><dt>Last checked</dt><dd>{router.last_checked_at?new Date(router.last_checked_at).toLocaleString():"never"}</dd><dt>Last sync</dt><dd>{router.last_synced_at?new Date(router.last_synced_at).toLocaleString():"never"}</dd></dl>{router.last_error&&<div className="form-message form-message-error">{router.last_error}</div>}</div></aside></div></>}
