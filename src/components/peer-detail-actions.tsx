"use client";
/* eslint-disable @next/next/no-img-element -- QR endpoint is session-protected and cannot be fetched by Next image optimization. */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Clipboard, Download, Edit3, KeyRound, LoaderCircle, Power, PowerOff, QrCode, RotateCcw, TimerReset, Trash2, X } from "lucide-react";
import { api } from "@/lib/client-api";

type QuotaPeriod = "one_time" | "daily" | "weekly" | "monthly";
type RouterOption={id:string;name:string};
type InterfaceOption={id:string;name:string;routerId:string;routerName:string};
type PoolOption={id:string;name:string;routerId:string;interfaceId:string;startIp:string;endIp:string;enabled:boolean};
type Peer = {
  id:string;routerId:string;interfaceId:string;poolId:string;clientIp:string;name:string;description:string;allowedAddress:string;clientAllowedIps:string;dnsServer:string;
  persistentKeepalive:number;mtu:number;expiresAt:string|null;endpointOverride:string;endpointPortOverride:number|null;
  disabled:boolean;disabledReason:"manual"|"expired"|"quota"|null;managed:boolean;
  quotaLimitBytes:string|null;quotaPeriod:QuotaPeriod|null;periodUsageBytes:string;quotaReachedAt:string|null;quotaBypassUntil:string|null;
};
type PeerAction = "enable" | "disable" | "delete" | "reset_usage" | "temporary_reenable";

export function PeerDetailActions({peer,routers,interfaces,pools}:{peer:Peer;routers:RouterOption[];interfaces:InterfaceOption[];pools:PoolOption[]}) {
  const router=useRouter();
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");
  const [qr,setQr]=useState(false);
  const [config,setConfig]=useState("");
  const [edit,setEdit]=useState(false);

  const action=async(value:PeerAction)=>{
    if(value==="delete"&&!confirm(`Permanently delete ${peer.name} from the MikroTik and local database?`))return;
    if(value==="reset_usage"&&!confirm(`Reset ${peer.name}'s current ${peer.quotaPeriod?.replace("one_time","total")} usage to zero? The previous usage remains in quota history.`))return;
    if(value==="temporary_reenable"&&!confirm(`Temporarily re-enable ${peer.name} for one hour even though the traffic limit is reached? Usage will continue to accumulate.`))return;
    setBusy(value);setError("");
    try{
      await api(`/api/peers/${peer.id}/action`,{method:"POST",body:JSON.stringify({action:value,minutes:60})});
      if(value==="delete")router.push("/peers");
      router.refresh();
    }catch(e){setError(e instanceof Error?e.message:"Action failed")}finally{setBusy("")}
  };
  const reveal=async()=>{setBusy("config");setError("");try{const response=await fetch(`/api/peers/${peer.id}/config`,{cache:"no-store"});if(!response.ok){const body=await response.json();throw new Error(body.error)}setConfig(await response.text())}catch(e){setError(e instanceof Error?e.message:"Configuration unavailable")}finally{setBusy("")}};

  return <>
    <div className="actions">
      {peer.managed&&<>
        <a className="button button-primary" href={`/api/peers/${peer.id}/config`}><Download/>Download config</a>
        <button className="button" onClick={()=>setQr(true)}><QrCode/>Show QR</button>
        <button className="button" onClick={reveal} disabled={!!busy}>{busy==="config"?<LoaderCircle className="spin"/>:<Clipboard/>}Copy config</button>
      </>}
      {peer.disabled&&peer.disabledReason==="quota"
        ? <button className="button" onClick={()=>action("temporary_reenable")} disabled={!!busy}>{busy==="temporary_reenable"?<LoaderCircle className="spin"/>:<TimerReset/>}Re-enable for 1 hour</button>
        : <button className="button" onClick={()=>action(peer.disabled?"enable":"disable")} disabled={!!busy}>{peer.disabled?<Power/>:<PowerOff/>}{peer.disabled?"Enable":"Disable"}</button>}
      {peer.quotaLimitBytes&&<button className="button" onClick={()=>action("reset_usage")} disabled={!!busy}>{busy==="reset_usage"?<LoaderCircle className="spin"/>:<RotateCcw/>}Reset current usage</button>}
      <button className="button" onClick={()=>setEdit(true)}><Edit3/>Edit</button>
      {peer.managed&&<button className="button" onClick={async()=>{if(!confirm("Regenerate this peer's key material? Existing client configurations will stop working immediately."))return;setBusy("regenerate");try{await api(`/api/peers/${peer.id}/regenerate`,{method:"POST",body:JSON.stringify({usePresharedKey:false})});router.refresh()}catch(e){setError(e instanceof Error?e.message:"Regeneration failed")}finally{setBusy("")}}}><KeyRound/>Regenerate</button>}
      <button className="button button-danger" onClick={()=>action("delete")} disabled={!!busy}>{busy==="delete"?<LoaderCircle className="spin"/>:<Trash2/>}Delete</button>
    </div>
    {error&&<div className="form-message form-message-error" role="alert" style={{marginTop:10}}>{error}</div>}
    {config&&<div className="dialog-backdrop"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="client-config-title"><header className="dialog-header"><div><h2 id="client-config-title">Client configuration</h2><p>Sensitive. Close it when finished.</p></div><button className="button button-ghost icon-button" aria-label="Close configuration" onClick={()=>setConfig("")}><X/></button></header><div className="dialog-body"><pre className="code-block">{config}</pre></div><footer className="dialog-footer"><button className="button" onClick={async()=>{await navigator.clipboard.writeText(config)}}><Clipboard/>Copy</button><button className="button button-primary" onClick={()=>setConfig("")}>Done</button></footer></section></div>}
    {qr&&<div className="dialog-backdrop"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="qr-title"><header className="dialog-header"><div><h2 id="qr-title">{peer.name} QR code</h2><p>Scan with the official WireGuard mobile app.</p></div><button className="button button-ghost icon-button" aria-label="Close QR code" onClick={()=>setQr(false)}><X/></button></header><div className="dialog-body" style={{textAlign:"center"}}><img src={`/api/peers/${peer.id}/qr`} alt={`WireGuard configuration QR code for ${peer.name}`} width={768} height={768} loading="lazy" style={{width:"min(100%,480px)",height:"auto",borderRadius:12}}/></div><footer className="dialog-footer"><button className="button" disabled={busy==="qr"} onClick={async()=>{setBusy("qr");setError("");try{await api(`/api/peers/${peer.id}/qr`,{method:"POST"});router.refresh()}catch(e){setError(e instanceof Error?e.message:"QR regeneration failed")}finally{setBusy("")}}}>{busy==="qr"?<LoaderCircle className="spin"/>:<RotateCcw/>}Regenerate</button><a className="button" href={`/api/peers/${peer.id}/qr?format=svg&download=1`}><Download/>SVG</a><a className="button button-primary" href={`/api/peers/${peer.id}/qr?download=1`}><Download/>PNG</a></footer></section></div>}
    {edit&&<PeerEditDialog peer={peer} routers={routers} interfaces={interfaces} pools={pools} close={()=>setEdit(false)}/>}
  </>;
}

function PeerEditDialog({peer,routers,interfaces,pools,close}:{peer:Peer;routers:RouterOption[];interfaces:InterfaceOption[];pools:PoolOption[];close:()=>void}) {
  const router=useRouter();
  const defaults=quotaDefaults(peer.quotaLimitBytes);
  const [quotaEnabled,setQuotaEnabled]=useState(Boolean(peer.quotaLimitBytes));
  const [routerId,setRouterId]=useState(peer.routerId);
  const [interfaceId,setInterfaceId]=useState(peer.interfaceId);
  const [poolId,setPoolId]=useState(peer.poolId);
  const available=interfaces.filter(item=>item.routerId===routerId);
  const availablePools=pools.filter(item=>item.routerId===routerId&&item.interfaceId===interfaceId&&item.enabled);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  return <div className="dialog-backdrop"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="peer-editor-title"><header className="dialog-header"><div><h2 id="peer-editor-title">Edit peer</h2><p>Comment, location, address, and quota changes are verified before RouterOS is changed.</p></div><button className="button button-ghost icon-button" aria-label="Close peer editor" onClick={close}><X/></button></header><form onSubmit={async e=>{e.preventDefault();setLoading(true);setError("");const f=new FormData(e.currentTarget);try{await api(`/api/peers/${peer.id}`,{method:"PUT",body:JSON.stringify({routerId,interfaceId,poolId,clientIp:f.get("clientIp"),name:f.get("name"),description:f.get("description"),allowedAddress:f.get("allowedAddress"),clientAllowedIps:f.get("clientAllowedIps"),dnsServer:f.get("dnsServer"),persistentKeepalive:Number(f.get("persistentKeepalive")),mtu:Number(f.get("mtu")),expiresAt:f.get("expiresAt")?new Date(String(f.get("expiresAt"))).toISOString():null,endpointOverride:f.get("endpointOverride")||null,endpointPortOverride:f.get("endpointPortOverride")?Number(f.get("endpointPortOverride")):null,quotaEnabled,quotaValue:quotaEnabled?Number(f.get("quotaValue")):null,quotaUnit:f.get("quotaUnit")||"GB",quotaPeriod:f.get("quotaPeriod")||"monthly"})});close();router.refresh()}catch(err){setError(err instanceof Error?err.message:"Save failed")}finally{setLoading(false)}}}>
    <div className="dialog-body form"><div className="form-grid">
      <div className="form-group"><label className="label" htmlFor="edit-peer-router">Router</label><select id="edit-peer-router" className="field" value={routerId} onChange={event=>{const next=event.target.value;const nextInterface=interfaces.find(item=>item.routerId===next)?.id||"";setRouterId(next);setInterfaceId(nextInterface);setPoolId(pools.find(item=>item.routerId===next&&item.interfaceId===nextInterface&&item.enabled)?.id||"")}}>{routers.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></div>
      <div className="form-group"><label className="label" htmlFor="edit-peer-interface">WireGuard interface</label><select id="edit-peer-interface" className="field" value={interfaceId} onChange={event=>{const next=event.target.value;setInterfaceId(next);setPoolId(pools.find(item=>item.routerId===routerId&&item.interfaceId===next&&item.enabled)?.id||"")}} required>{available.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select></div>
      <div className="form-group span-2"><label className="label" htmlFor="edit-peer-pool">WireGuard pool</label><select id="edit-peer-pool" className="field" value={poolId} onChange={event=>setPoolId(event.target.value)} required><option value="" disabled>Select a pool</option>{availablePools.map(item=><option value={item.id} key={item.id}>{item.name} ({item.startIp}–{item.endIp})</option>)}</select></div>
      <Form label="Name" name="name" value={peer.name}/><Form label="Client IP" name="clientIp" value={peer.clientIp} mono/>
      <div className="form-group span-2"><label className="label" htmlFor="peer-edit-allowedAddress">RouterOS allowed address</label><input id="peer-edit-allowedAddress" className="field mono" name="allowedAddress" defaultValue={peer.allowedAddress}/></div>
      <div className="form-group span-2"><label className="label" htmlFor="peer-edit-description">Comment <span className="hint">(optional)</span></label><textarea id="peer-edit-description" className="field" name="description" defaultValue={peer.description} maxLength={500} rows={2}/><div className="hint">Stored locally and synchronized to the MikroTik peer comment.</div></div>
      <Form label="Client AllowedIPs" name="clientAllowedIps" value={peer.clientAllowedIps} mono/><Form label="DNS server" name="dnsServer" value={peer.dnsServer}/>
      <Form label="Keepalive" name="persistentKeepalive" value={String(peer.persistentKeepalive)} type="number"/><Form label="MTU" name="mtu" value={String(peer.mtu)} type="number"/>
      <Form label="Endpoint override" name="endpointOverride" value={peer.endpointOverride}/><Form label="Endpoint port override" name="endpointPortOverride" value={peer.endpointPortOverride?.toString()||""} type="number"/>
      <Form label="Expiration" name="expiresAt" value={peer.expiresAt?peer.expiresAt.slice(0,16):""} type="datetime-local"/>
      <fieldset className="form-group span-2 quota-fields"><legend>Traffic limit</legend><div className="form-grid"><div className="form-group"><label className="label" htmlFor="edit-traffic-mode">Usage policy</label><select id="edit-traffic-mode" className="field" value={quotaEnabled?"custom":"unlimited"} onChange={event=>setQuotaEnabled(event.target.value==="custom")}><option value="unlimited">Unlimited</option><option value="custom">Custom traffic limit</option></select></div>{quotaEnabled&&<><div className="form-group"><label className="label" htmlFor="edit-quota-value">Limit</label><div className="input-pair"><input id="edit-quota-value" className="field" name="quotaValue" type="number" min="0.001" max="1000000" step="0.001" required defaultValue={defaults.value}/><select className="field" name="quotaUnit" aria-label="Traffic limit unit" defaultValue={defaults.unit}><option>MB</option><option>GB</option><option>TB</option></select></div></div><div className="form-group span-2"><label className="label" htmlFor="edit-quota-period">Quota period</label><select id="edit-quota-period" className="field" name="quotaPeriod" defaultValue={peer.quotaPeriod||"monthly"}><option value="one_time">One-time / total</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select><div className="hint">Changing the amount preserves current usage. Changing the period archives and starts a new period.</div></div></>}</div></fieldset>
    </div>{error&&<div className="form-message form-message-error" role="alert">{error}</div>}</div><footer className="dialog-footer"><button type="button" className="button" onClick={close}>Cancel</button><button className="button button-primary" disabled={loading}>{loading?<LoaderCircle className="spin"/>:<Edit3/>}Save changes</button></footer>
  </form></section></div>;
}

function Form({label,name,value,type="text",mono=false}:{label:string;name:string;value:string;type?:string;mono?:boolean}){const id=`peer-edit-${name}`;return <div className="form-group"><label className="label" htmlFor={id}>{label}</label><input id={id} className={`field ${mono?"mono":""}`} name={name} defaultValue={value} type={type}/></div>}

function quotaDefaults(bytes:string|null):{value:number;unit:"MB"|"GB"|"TB"}{
  if(!bytes)return{value:50,unit:"GB"};
  const value=BigInt(bytes);
  const tb=1024n**4n;const gb=1024n**3n;const mb=1024n**2n;
  if(value>=tb)return{value:Number(value)/Number(tb),unit:"TB"};
  if(value>=gb)return{value:Number(value)/Number(gb),unit:"GB"};
  return{value:Number(value)/Number(mb),unit:"MB"};
}
