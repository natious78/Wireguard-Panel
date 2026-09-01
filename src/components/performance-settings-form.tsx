"use client";

import { useState } from "react";
import { LoaderCircle,Save } from "lucide-react";
import { api } from "@/lib/client-api";
import type { PerformancePolicy } from "@/server/settings";

type RetentionPolicy={rawTrafficHours:number;hourlyDays:number;dailyMonths:number};

export function PerformanceSettingsForm({policy,retention}:{policy:PerformancePolicy;retention:RetentionPolicy}){
  const[loading,setLoading]=useState(false);const[message,setMessage]=useState("");
  return <form className="form" onSubmit={async event=>{event.preventDefault();setLoading(true);setMessage("");const form=new FormData(event.currentTarget);
    const number=(name:string)=>Number(form.get(name));
    try{await api("/api/settings/performance",{method:"PUT",body:JSON.stringify({
      trafficPollSeconds:number("trafficPollSeconds"),syncIntervalSeconds:number("syncIntervalSeconds"),routerHealthSeconds:number("routerHealthSeconds"),
      bandwidthSeconds:number("bandwidthSeconds"),operationReconciliationSeconds:number("operationReconciliationSeconds"),trafficAggregationSeconds:number("trafficAggregationSeconds"),
      maintenanceSeconds:number("maintenanceSeconds"),rawTrafficSampleSeconds:number("rawTrafficSampleSeconds"),auditRetentionDays:number("auditRetentionDays"),
      logLevel:form.get("logLevel"),rawTrafficHours:number("rawTrafficHours"),hourlyDays:number("hourlyDays"),dailyMonths:number("dailyMonths"),
    })});setMessage("Performance settings saved. Workers apply changes within about one minute.")}catch(error){setMessage(error instanceof Error?error.message:"Save failed")}finally{setLoading(false)}}}>
    <fieldset className="form-section"><legend>Polling and reconciliation</legend><div className="form-grid">
      <NumberField name="trafficPollSeconds" label="Traffic poll interval" value={policy.trafficPollSeconds} min={10} max={3600} hint="Seconds. Handshake, RX/TX, and quota enforcement."/>
      <NumberField name="rawTrafficSampleSeconds" label="Raw sample interval" value={policy.rawTrafficSampleSeconds} min={policy.trafficPollSeconds} max={3600} hint="Seconds. Quota counters remain durable on every poll; history rows are sampled less often."/>
      <NumberField name="syncIntervalSeconds" label="Full synchronization" value={policy.syncIntervalSeconds} min={60} max={86400} hint="Seconds. Peer and interface configuration drift."/>
      <NumberField name="routerHealthSeconds" label="Router health" value={policy.routerHealthSeconds} min={30} max={3600} hint="Seconds. Unreachable routers use exponential backoff."/>
      <NumberField name="bandwidthSeconds" label="Bandwidth reconciliation" value={policy.bandwidthSeconds} min={60} max={86400} hint="Seconds. Queue and shaping drift checks."/>
      <NumberField name="operationReconciliationSeconds" label="Pending operations" value={policy.operationReconciliationSeconds} min={30} max={3600} hint="Seconds. Recovery of incomplete router mutations."/>
    </div></fieldset>
    <fieldset className="form-section"><legend>Retention and maintenance</legend><div className="form-grid">
      <NumberField name="trafficAggregationSeconds" label="Traffic aggregation" value={policy.trafficAggregationSeconds} min={300} max={86400} hint="Seconds. Hourly is recommended for router storage."/>
      <NumberField name="maintenanceSeconds" label="Maintenance interval" value={policy.maintenanceSeconds} min={3600} max={86400} hint="Seconds. Session and audit cleanup; never more than hourly."/>
      <NumberField name="rawTrafficHours" label="Raw traffic retention" value={retention.rawTrafficHours} min={1} max={744} hint="Hours. Keep short on RouterOS-hosted deployments."/>
      <NumberField name="hourlyDays" label="Hourly history" value={retention.hourlyDays} min={1} max={3660} hint="Days."/>
      <NumberField name="dailyMonths" label="Daily history" value={retention.dailyMonths} min={1} max={120} hint="Months."/>
      <div className="form-group"><label className="label" htmlFor="audit-retention">Audit retention</label><select id="audit-retention" className="field" name="auditRetentionDays" defaultValue={policy.auditRetentionDays} aria-describedby="audit-retention-hint">{[30,90,180,365,0].map(value=><option key={value} value={value}>{value===0?"Unlimited":`${value} days`}</option>)}</select><div className="hint" id="audit-retention-hint">Unlimited is not recommended on router storage.</div></div>
      <div className="form-group"><label className="label" htmlFor="log-level">Diagnostic log level</label><select id="log-level" className="field" name="logLevel" defaultValue={policy.logLevel} aria-describedby="log-level-hint"><option value="error">Error</option><option value="warn">Warn</option><option value="info">Info</option><option value="debug">Debug</option></select><div className="hint" id="log-level-hint">Logs use stdout/stderr only; successful polling stays silent.</div></div>
    </div></fieldset>
    {message&&<div className={`form-message ${message.includes("saved")?"form-message-success":"form-message-error"}`} role={message.includes("saved")?"status":"alert"} aria-live={message.includes("saved")?"polite":"assertive"}>{message}</div>}
    <div><button className="button button-primary" disabled={loading} aria-busy={loading}>{loading?<LoaderCircle className="spin"/>:<Save/>}{loading?"Saving performance settings…":"Save performance settings"}</button></div>
  </form>;
}

function NumberField({name,label,value,min,max,hint}:{name:string;label:string;value:number;min:number;max:number;hint:string}){
  const hintId=`${name}-hint`;
  return <div className="form-group"><label className="label" htmlFor={name}>{label}</label><input id={name} className="field" name={name} type="number" min={min} max={max} defaultValue={value} required aria-describedby={hintId}/><div className="hint" id={hintId}>{hint}</div></div>;
}
