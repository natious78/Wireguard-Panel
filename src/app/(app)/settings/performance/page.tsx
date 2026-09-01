import { Activity,Database,HardDrive,MemoryStick,ScrollText,ServerCog } from "lucide-react";
import Link from "next/link";
import { PerformanceSettingsForm } from "@/components/performance-settings-form";
import { Metric,PageHeader,StatusBadge } from "@/components/ui";
import { query } from "@/lib/db";
import { formatBytes } from "@/server/status";
import { getPerformancePolicy } from "@/server/settings";
import { getSystemHealth } from "@/server/system-health";

type RetentionPolicy={rawTrafficHours:number;hourlyDays:number;dailyMonths:number;archiveDeletedPeers:boolean};
export const metadata={title:"Performance & System Health"};

export default async function PerformancePage(){
  const[policy,retentionResult,health]=await Promise.all([getPerformancePolicy(),query<{value:RetentionPolicy}>("SELECT value FROM settings WHERE key='retention_policy'"),getSystemHealth()]);
  const retention=retentionResult.rows[0]?.value??{rawTrafficHours:24,hourlyDays:90,dailyMonths:24,archiveDeletedPeers:true};
  return <><PageHeader title="Performance & System Health" description="Bound polling, retention, writes, and resource use for server and MikroTik deployments." actions={<Link className="button" href="/settings">Back to settings</Link>}/>
    <section className="metrics">
      <Metric label="Application process RAM" value={formatBytes(health.processRssBytes)} foot="This web process only, not RouterOS host RAM" icon={MemoryStick}/>
      <Metric label="Database" value={formatBytes(health.databaseBytes)} foot={`${formatBytes(health.trafficSnapshotBytes)} traffic · ${formatBytes(health.auditBytes)} audit`} icon={Database}/>
      <Metric label="Persistent storage" value={health.storageUsedPercent===null?"Unavailable":`${health.storageUsedPercent}% used`} foot={health.storageAvailableBytes===null?health.storagePath:`${formatBytes(health.storageAvailableBytes)} available at ${health.storagePath}`} icon={HardDrive}/>
      <Metric label="Worker scheduler" value={<StatusBadge status={health.workerFailures?"partial":"connected"}>{health.workerFailures?"Needs attention":"Healthy"}</StatusBadge>} foot={`${health.workerJobs} jobs · ${health.workerLastUpdate?`updated ${new Date(health.workerLastUpdate).toLocaleString()}`:"not started"}`} icon={ServerCog}/>
    </section>
    {health.storageLevel!=="ok"&&health.storageLevel!=="unknown"&&<div className={`form-message ${health.storageLevel==="critical"?"form-message-error":""}`} role="alert">Persistent storage is {health.storageLevel}. Free space before traffic or audit data can exhaust the volume.</div>}
    <div className="grid-sidebar"><section className="card"><div className="card-header"><div><h2><Activity size={18}/> Runtime policy</h2><p>Safe minimums prevent tight loops and uncontrolled router load.</p></div></div><div className="card-body"><PerformanceSettingsForm policy={policy} retention={retention}/></div></section>
      <aside className="card"><div className="card-header"><h2><ScrollText size={18}/> Storage behavior</h2></div><div className="card-body"><dl className="detail-list"><dt>Diagnostic logs</dt><dd>stdout/stderr only</dd><dt>Raw traffic rows</dt><dd>Every {policy.rawTrafficSampleSeconds}s</dd><dt>Quota counters</dt><dd>Every {policy.trafficPollSeconds}s</dd><dt>Audit cleanup</dt><dd>{policy.auditRetentionDays===0?"Disabled":`${policy.auditRetentionDays} days`}</dd><dt>Aggregation</dt><dd>Every {Math.round(policy.trafficAggregationSeconds/60)} minutes</dd></dl><p className="cell-sub">RouterOS host RAM and CPU are intentionally not inferred from container metrics. Use RouterOS System → Resources for authoritative host values.</p></div></aside>
    </div></>;
}
