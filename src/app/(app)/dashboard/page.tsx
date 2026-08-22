import { Activity, Cable, Router, Waypoints } from "lucide-react";
import Link from "next/link";
import { PageHeader, Metric, StatusBadge } from "@/components/ui";
import { query } from "@/lib/db";
import { getStatusThresholds } from "@/server/settings";
import { formatBytes } from "@/server/status";

type Counts = { routers:string;connected:string;interfaces:string;peers:string;online:string;recent:string;offline:string;never:string;unreachable:string;disabled:string;expired:string;near_limit:string;over_limit:string;quota_disabled:string;rx:string;tx:string };
type RouterCard = { id:string;name:string;management_ip:string;connection_status:string;stats_poll_status:string;routeros_version:string|null;identity:string|null;interfaces:string;peers:string;online:string;last_synced_at:Date|null;last_stats_success_at:Date|null };

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const thresholds = await getStatusThresholds();
  const [countsResult, routersResult] = await Promise.all([
    query<Counts>(`SELECT
      (SELECT count(*) FROM routers)::text routers,(SELECT count(*) FROM routers WHERE connection_status='connected')::text connected,
      (SELECT count(*) FROM wireguard_interfaces)::text interfaces,(SELECT count(*) FROM peers)::text peers,
      (SELECT count(*) FROM peers p JOIN routers r ON r.id=p.router_id WHERE NOT p.disabled AND NOT coalesce(p.remote_disabled,false) AND NOT p.expired AND p.quota_reached_at IS NULL AND r.stats_poll_status='reachable' AND p.last_handshake_at>now()-make_interval(secs=>$1))::text online,
      (SELECT count(*) FROM peers p JOIN routers r ON r.id=p.router_id WHERE NOT p.disabled AND NOT coalesce(p.remote_disabled,false) AND NOT p.expired AND p.quota_reached_at IS NULL AND r.stats_poll_status='reachable' AND p.last_handshake_at<=now()-make_interval(secs=>$1) AND p.last_handshake_at>now()-make_interval(secs=>$2))::text recent,
      (SELECT count(*) FROM peers p JOIN routers r ON r.id=p.router_id WHERE NOT p.disabled AND NOT coalesce(p.remote_disabled,false) AND NOT p.expired AND p.quota_reached_at IS NULL AND r.stats_poll_status='reachable' AND p.last_handshake_at<=now()-make_interval(secs=>$2))::text offline,
      (SELECT count(*) FROM peers p JOIN routers r ON r.id=p.router_id WHERE NOT p.disabled AND NOT coalesce(p.remote_disabled,false) AND NOT p.expired AND p.quota_reached_at IS NULL AND r.stats_poll_status<>'unreachable' AND p.last_handshake_at IS NULL)::text never,
      (SELECT count(*) FROM peers p JOIN routers r ON r.id=p.router_id WHERE NOT p.disabled AND NOT coalesce(p.remote_disabled,false) AND NOT p.expired AND p.quota_reached_at IS NULL AND r.stats_poll_status='unreachable')::text unreachable,
      (SELECT count(*) FROM peers WHERE (disabled OR coalesce(remote_disabled,false)) AND NOT expired AND quota_reached_at IS NULL)::text disabled,
      (SELECT count(*) FROM peers WHERE expired)::text expired,
      (SELECT count(*) FROM peers WHERE quota_limit_bytes IS NOT NULL AND (period_rx_bytes+period_tx_bytes)*100>=quota_limit_bytes*80 AND (period_rx_bytes+period_tx_bytes)<quota_limit_bytes)::text near_limit,
      (SELECT count(*) FROM peers WHERE quota_limit_bytes IS NOT NULL AND (period_rx_bytes+period_tx_bytes)>=quota_limit_bytes)::text over_limit,
      (SELECT count(*) FROM peers WHERE disabled_reason='quota')::text quota_disabled,
      coalesce((SELECT sum(lifetime_rx_bytes) FROM peers),0)::text rx,coalesce((SELECT sum(lifetime_tx_bytes) FROM peers),0)::text tx`, [thresholds.onlineSeconds, thresholds.recentSeconds]),
    query<RouterCard>(`SELECT r.id,r.name,r.management_ip,r.connection_status,r.stats_poll_status,r.routeros_version,r.identity,r.last_synced_at,r.last_stats_success_at,
      count(DISTINCT i.id)::text interfaces,count(DISTINCT p.id)::text peers,count(DISTINCT p.id) FILTER(WHERE NOT p.disabled AND NOT coalesce(p.remote_disabled,false) AND NOT p.expired AND p.quota_reached_at IS NULL AND r.stats_poll_status='reachable' AND p.last_handshake_at>now()-make_interval(secs=>$1))::text online
      FROM routers r LEFT JOIN wireguard_interfaces i ON i.router_id=r.id LEFT JOIN peers p ON p.router_id=r.id GROUP BY r.id ORDER BY r.name`, [thresholds.onlineSeconds]),
  ]);
  const c = countsResult.rows[0];
  const disconnected = Number(c.routers) - Number(c.connected);
  const presence = [
    { label: "Online", status: "online", value: c.online, href: "/peers?status=online" },
    { label: "Recently active", status: "recent", value: c.recent, href: "/peers?status=recent" },
    { label: "Offline", status: "offline", value: c.offline, href: "/peers?status=offline" },
    { label: "Never connected", status: "never", value: c.never, href: "/peers?status=never" },
    { label: "Router unreachable", status: "router_unreachable", value: c.unreachable, href: "/peers?status=router_unreachable" },
    { label: "Disabled", status: "disabled", value: c.disabled, href: "/peers?status=disabled" },
    { label: "Expired", status: "expired", value: c.expired, href: "/peers?status=expired" },
    { label: "Near limit", status: "warning", value: c.near_limit, href: "/peers?quota=near" },
    { label: "Limit reached", status: "traffic_limit_reached", value: c.over_limit, href: "/peers?quota=reached" },
    { label: "Quota blocked", status: "traffic_limit_reached", value: c.quota_disabled, href: "/peers?status=traffic_limit_reached" },
  ];

  return <>
    <PageHeader title="Operations overview" description="Last-handshake presence, quota enforcement, and RouterOS reachability across the estate." actions={<Link className="button button-primary" href="/peers?create=1"><Waypoints />Create peer</Link>} />
    <section className="metrics" aria-label="Key metrics">
      <Metric label="Routers" value={c.routers} foot={`${c.connected} connected · ${disconnected} unavailable`} icon={Router} />
      <Metric label="Interfaces" value={c.interfaces} foot="Discovered WireGuard interfaces" icon={Cable} />
      <Metric label="Peers" value={c.peers} foot={`${c.online} online · ${c.recent} recently active`} icon={Waypoints} />
      <Metric label="Lifetime traffic" value={formatBytes(BigInt(c.rx) + BigInt(c.tx))} foot={`RX ${formatBytes(c.rx)} · TX ${formatBytes(c.tx)}`} icon={Activity} />
    </section>
    <section className="card status-overview" aria-labelledby="peer-state-heading">
      <div className="card-header"><div><h2 id="peer-state-heading">Peer state</h2><p>Based on handshake age and explicit enforcement state—not RX/TX traffic.</p></div><Link className="button button-small" href="/peers">Open peer inventory</Link></div>
      <div className="status-overview-grid">{presence.map((item) => <Link href={item.href} key={item.label}><StatusBadge status={item.status}>{item.label}</StatusBadge><strong>{item.value}</strong></Link>)}</div>
    </section>
    <section className="card router-estate">
      <div className="card-header"><h2>Router estate</h2><Link className="button button-small" href="/routers">Manage routers</Link></div>
      <div className="card-body"><div className="router-grid">{routersResult.rows.map((router) => <article className="card router-card" key={router.id}>
        <div className="router-card-top"><div><h3><Link href={`/routers/${router.id}`}>{router.name}</Link></h3><div className="router-meta">{router.identity || router.management_ip}<br />RouterOS {router.routeros_version || "—"}</div></div><StatusBadge status={router.stats_poll_status === "unreachable" ? "router_unreachable" : router.connection_status} /></div>
        <div className="router-facts"><div className="router-fact"><strong>{router.interfaces}</strong><span>interfaces</span></div><div className="router-fact"><strong>{router.online}/{router.peers}</strong><span>online peers</span></div></div>
        <div className="cell-sub">Statistics confirmed {router.last_stats_success_at ? new Date(router.last_stats_success_at).toLocaleString() : "never"}</div>
      </article>)}</div></div>
    </section>
  </>;
}
