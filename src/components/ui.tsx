import type { LucideIcon } from "lucide-react";
import { periodLabel, quotaState, type QuotaPeriod } from "@/server/quota";

export function PageHeader({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) {
  return <header className="page-header"><div><h1 className="page-title">{title}</h1><p className="page-subtitle">{description}</p></div>{actions && <div className="actions">{actions}</div>}</header>;
}

export function Metric({ label, value, foot, icon: Icon }: { label: string; value: React.ReactNode; foot?: React.ReactNode; icon: LucideIcon }) {
  return <div className="metric"><div className="metric-head"><span>{label}</span><span className="metric-icon"><Icon aria-hidden="true" /></span></div><strong className="metric-value">{value}</strong>{foot && <div className="metric-foot">{foot}</div>}</div>;
}

export function StatusBadge({ status, children }: { status: string; children?: React.ReactNode }) {
  return <span className={`status status-${status.replaceAll("_", "-")}`}>{children ?? status.replaceAll("_", " ")}</span>;
}

export function HandshakeActivity({at,status,showStatus=false}:{at:string|Date|null;status?:string;showStatus?:boolean}){
  const parsed=at?new Date(at):null;const valid=Boolean(parsed&&Number.isFinite(parsed.getTime()));
  const copy=valid?`${status==="router_unreachable"?"Last known handshake":"Last handshake"}: ${formatAgo(parsed!)}`:"No handshake recorded";
  return <div className="handshake-activity">{showStatus&&status&&<StatusBadge status={status}/>}<span>{copy}</span></div>
}

export function formatAgo(date:Date,now=new Date()){
  const seconds=Math.max(0,Math.floor((now.getTime()-date.getTime())/1000));
  if(seconds<60)return`${seconds} second${seconds===1?"":"s"} ago`;
  const minutes=Math.floor(seconds/60);if(minutes<60)return`${minutes} minute${minutes===1?"":"s"} ago`;
  const hours=Math.floor(minutes/60);const remainMinutes=minutes%60;if(hours<24)return`${hours} hour${hours===1?"":"s"}${remainMinutes?` ${remainMinutes} minute${remainMinutes===1?"":"s"}`:""} ago`;
  const days=Math.floor(hours/24);const remainHours=hours%24;return`${days} day${days===1?"":"s"}${remainHours?` ${remainHours} hour${remainHours===1?"":"s"}`:""} ago`;
}

export function EmptyState({ icon: Icon, title, message, action }: { icon: LucideIcon; title: string; message: string; action?: React.ReactNode }) {
  return <div className="empty"><Icon aria-hidden="true" /><h3>{title}</h3><p>{message}</p>{action}</div>;
}

export function QuotaUsage({usedBytes,limitBytes,period,compact=false}:{usedBytes:string;limitBytes:string|null;period:QuotaPeriod|null;compact?:boolean}) {
  const used=BigInt(usedBytes||"0");
  const limit=limitBytes?BigInt(limitBytes):null;
  const quota=quotaState(used,limit);
  if(!limit)return <div className="quota-usage quota-unlimited"><strong>Unlimited</strong>{!compact&&<span>{formatCompactBytes(used)} lifetime usage</span>}</div>;
  const shown=Math.min(100,Math.max(0,quota.percentage??0));
  const stateLabel={normal:"Within limit",warning:"Warning",high:"High usage",reached:"Traffic limit reached",unlimited:"Unlimited"}[quota.state];
  return <div className={`quota-usage quota-${quota.state}`}>
    <div className="quota-copy"><strong>{compact?`${quota.percentage?.toFixed(1)}%`:`${formatCompactBytes(used)} / ${formatCompactBytes(limit)}`}</strong><span>{compact?stateLabel:`${quota.percentage?.toFixed(1)}% · ${periodLabel(period)} · ${stateLabel}`}</span></div>
    <div className="traffic-bar" role="progressbar" aria-label={`Traffic quota: ${stateLabel}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100,Math.round(quota.percentage??0))}><span style={{width:`${shown}%`}}/></div>
  </div>;
}

function formatCompactBytes(value:bigint){if(value<=0n)return"0 B";const units=["B","KB","MB","GB","TB","PB"];let amount=Number(value);let index=0;while(amount>=1024&&index<units.length-1){amount/=1024;index+=1}return`${amount>=10||index===0?amount.toFixed(0):amount.toFixed(2)} ${units[index]}`}
