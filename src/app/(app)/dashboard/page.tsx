import { Activity, Cable, CircleOff, Router, Waypoints, Wifi, WifiOff, Zap } from "lucide-react";
import { query } from "@/lib/db";
import { formatBytes } from "@/server/status";
import { Metric, PageHeader, StatusBadge } from "@/components/ui";
import { getStatusThresholds } from "@/server/settings";
import Link from "next/link";

type Counts = { routers:string; connected:string; interfaces:string; peers:string; online:string; disabled:string; expired:string; rx:string; tx:string };
type RouterCard = { id:string;name:string;management_ip:string;connection_status:string;routeros_version:string|null;identity:string|null;interfaces:string;peers:string;online:string;last_synced_at:Date|null };

export const metadata = { title:"Dashboard" };
export default async function DashboardPage(){
  const thresholds=await getStatusThresholds();
  const [countsResult,routersResult]=await Promise.all([
    query<Counts>(`SELECT
      (SELECT count(*) FROM routers)::text routers,
      (SELECT count(*) FROM routers WHERE connection_status='connected')::text connected,
      (SELECT count(*) FROM wireguard_interfaces)::text interfaces,
      (SELECT count(*) FROM peers)::text peers,
      (SELECT count(*) FROM peers WHERE disabled=false AND expired=false AND last_handshake_at > now() - make_interval(secs=>$1))::text online,
      (SELECT count(*) FROM peers WHERE disabled=true AND expired=false)::text disabled,
      (SELECT count(*) FROM peers WHERE expired=true)::text expired,
      coalesce((SELECT sum(rx_bytes) FROM peers),0)::text rx,
      coalesce((SELECT sum(tx_bytes) FROM peers),0)::text tx`,[thresholds.onlineSeconds]),
    query<RouterCard>(`SELECT r.id,r.name,r.management_ip,r.connection_status,r.routeros_version,r.identity,r.last_synced_at,
      count(DISTINCT i.id)::text interfaces,count(DISTINCT p.id)::text peers,
      count(DISTINCT p.id) FILTER(WHERE p.disabled=false AND p.expired=false AND p.last_handshake_at > now()-make_interval(secs=>$1))::text online
      FROM routers r LEFT JOIN wireguard_interfaces i ON i.router_id=r.id LEFT JOIN peers p ON p.router_id=r.id
      GROUP BY r.id ORDER BY r.name`,[thresholds.onlineSeconds])
  ]);
  const c=countsResult.rows[0]; const disconnected=Number(c.routers)-Number(c.connected); const offline=Number(c.peers)-Number(c.online)-Number(c.disabled)-Number(c.expired);
  return <>
    <PageHeader title="Operations overview" description="Live posture across every managed MikroTik router and WireGuard peer." actions={<Link className="button button-primary" href="/peers?create=1"><Waypoints size={17}/>Create peer</Link>} />
    <section className="metrics" aria-label="Key metrics">
      <Metric label="Routers" value={c.routers} foot={`${c.connected} connected · ${disconnected} unavailable`} icon={Router}/>
      <Metric label="Interfaces" value={c.interfaces} foot="Discovered WireGuard interfaces" icon={Cable}/>
      <Metric label="Peers" value={c.peers} foot={`${c.online} online · ${Math.max(0,offline)} offline`} icon={Waypoints}/>
      <Metric label="Traffic" value={formatBytes(BigInt(c.rx)+BigInt(c.tx))} foot={`RX ${formatBytes(c.rx)} · TX ${formatBytes(c.tx)}`} icon={Activity}/>
      <Metric label="Online" value={c.online} foot={`Handshake within ${thresholds.onlineSeconds}s`} icon={Wifi}/>
      <Metric label="Offline" value={Math.max(0,offline)} foot="No recent handshake" icon={WifiOff}/>
      <Metric label="Disabled" value={c.disabled} foot="Administratively disabled" icon={CircleOff}/>
      <Metric label="Expired" value={c.expired} foot="Retained, not deleted" icon={Zap}/>
    </section>
    <section className="card"><div className="card-header"><h2>Router estate</h2><Link className="button button-small" href="/routers">Manage routers</Link></div><div className="card-body">
      {routersResult.rows.length ? <div className="router-grid">{routersResult.rows.map(router=><article className="card router-card" key={router.id}><div className="router-card-top"><div><h3><Link href={`/routers/${router.id}`}>{router.name}</Link></h3><div className="router-meta">{router.identity||router.management_ip}<br/>RouterOS {router.routeros_version||"—"}</div></div><StatusBadge status={router.connection_status}/></div><div className="router-facts"><div className="router-fact"><strong>{router.interfaces}</strong><span>interfaces</span></div><div className="router-fact"><strong>{router.online}/{router.peers}</strong><span>online peers</span></div></div><div className="cell-sub">Last sync {router.last_synced_at?new Date(router.last_synced_at).toLocaleString():"never"}</div></article>)}</div> : <div className="empty"><Router/><h3>No routers configured</h3><p>Add your first MikroTik router to discover WireGuard interfaces and existing peers.</p><Link className="button button-primary" href="/routers?add=1">Add router</Link></div>}
    </div></section>
  </>;
}
