"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Save, X } from "lucide-react";
import { api } from "@/lib/client-api";

type RouterOption = { id: string; name: string; defaultInterfaceId:string|null;defaultPoolId:string|null;defaultDns:string|null;defaultAllowedIps:string|null;defaultEndpoint:string|null;defaultMtu:number|null;defaultKeepalive:number|null;defaultQuotaBytes:string|null;defaultQuotaPeriod:string|null;defaultBandwidthMode:"global"|"unlimited"|"custom";defaultDownloadBps:string|null;defaultUploadBps:string|null;defaultExpirationDays:number|null };
type InterfaceOption = { id: string; name: string; routerId: string; routerName: string; addresses: string[] };
type PoolOption = {
  id: string; name: string; routerId: string; interfaceId: string; network: string; startIp: string; endIp: string;
  dns: string; clientAllowedIps: string; endpoint: string; mtu: number; persistentKeepalive: number;
  total: number; available: number; nextIp: string | null; enabled: boolean;
};
type BandwidthProfileOption={id:string;name:string;downloadBps:string|null;uploadBps:string|null};
type ProfileOption={id:string;name:string;description:string|null;poolId:string|null;dns:string|null;clientAllowedIps:string|null;mtu:number|null;keepalive:number|null;quotaBytes:string|null;quotaPeriod:string|null;bandwidthProfileId:string|null;expirationDays:number|null};
type GlobalBandwidth={mode:"unlimited"|"custom";downloadBps:string|null;uploadBps:string|null};

export function PeerCreateDialog({ routers, interfaces, pools, profiles, bandwidthProfiles, globalBandwidth }: { routers: RouterOption[]; interfaces: InterfaceOption[]; pools: PoolOption[];profiles:ProfileOption[];bandwidthProfiles:BandwidthProfileOption[];globalBandwidth:GlobalBandwidth }) {
  const router = useRouter();
  const [routerId, setRouterId] = useState(routers[0]?.id || "");
  const interfaceOptions = useMemo(() => interfaces.filter((item) => item.routerId === routerId), [interfaces, routerId]);
  const [interfaceId, setInterfaceId] = useState(interfaces.find(item=>item.id===routers[0]?.defaultInterfaceId)?.id||interfaceOptions[0]?.id || "");
  const poolOptions = useMemo(() => pools.filter((item) => item.interfaceId === interfaceId && item.enabled), [pools, interfaceId]);
  const [poolId, setPoolId] = useState(pools.find(item=>item.id===routers[0]?.defaultPoolId&&item.enabled)?.id||poolOptions[0]?.id || "");
  const pool = poolOptions.find((item) => item.id === poolId) || poolOptions[0];
  const [assignmentMode, setAssignmentMode] = useState<"automatic" | "manual">("automatic");
  const [quotaEnabled, setQuotaEnabled] = useState(Boolean(routers[0]?.defaultQuotaBytes));
  const [profileId,setProfileId]=useState("");
  const [bandwidthMode,setBandwidthMode]=useState<"default"|"unlimited"|"custom">("default");
  const [downloadMbps,setDownloadMbps]=useState("20");const[uploadMbps,setUploadMbps]=useState("10");
  const [expirationMode, setExpirationMode] = useState<"never" | "date">(routers[0]?.defaultExpirationDays?"date":"never");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const close = () => router.push("/peers");
  const selectedRouter=routers.find(item=>item.id===routerId);const selectedProfile=profiles.find(item=>item.id===profileId);
  const selectedBandwidthProfile=bandwidthProfiles.find(item=>item.id===selectedProfile?.bandwidthProfileId);
  const effectiveBandwidth=bandwidthMode==="unlimited"?{label:"Unlimited",source:"Peer override"}:bandwidthMode==="custom"?{label:`${downloadMbps||"—"} Mbps ↓ / ${uploadMbps||"—"} Mbps ↑`,source:"Peer override"}:selectedBandwidthProfile?{label:bandwidthLabel(selectedBandwidthProfile.downloadBps,selectedBandwidthProfile.uploadBps),source:`${selectedProfile?.name} profile`}:selectedRouter?.defaultBandwidthMode==="custom"?{label:bandwidthLabel(selectedRouter.defaultDownloadBps,selectedRouter.defaultUploadBps),source:`${selectedRouter.name} router default`}:selectedRouter?.defaultBandwidthMode==="unlimited"?{label:"Unlimited",source:`${selectedRouter.name} router default`}:{label:bandwidthLabel(globalBandwidth.downloadBps,globalBandwidth.uploadBps),source:"Global default"};
  const effectiveDns=selectedProfile?.dns||selectedRouter?.defaultDns||pool?.dns||"1.1.1.1";const effectiveAllowed=selectedProfile?.clientAllowedIps||selectedRouter?.defaultAllowedIps||pool?.clientAllowedIps||"0.0.0.0/0";
  const effectiveMtu=selectedProfile?.mtu||selectedRouter?.defaultMtu||pool?.mtu||1420;const effectiveKeepalive=selectedProfile?.keepalive??selectedRouter?.defaultKeepalive??pool?.persistentKeepalive??25;

  const chooseInterface = (nextRouter: string) => {
    const defaults=routers.find(item=>item.id===nextRouter);const nextInterface = interfaces.find(item=>item.id===defaults?.defaultInterfaceId&&item.routerId===nextRouter)?.id||interfaces.find((item) => item.routerId === nextRouter)?.id || "";
    setInterfaceId(nextInterface);
    setPoolId(pools.find(item=>item.id===defaults?.defaultPoolId&&item.interfaceId===nextInterface&&item.enabled)?.id||pools.find((item) => item.interfaceId === nextInterface && item.enabled)?.id || "");
    if(!profileId){setQuotaEnabled(Boolean(defaults?.defaultQuotaBytes));setExpirationMode(defaults?.defaultExpirationDays?"date":"never")}
  };

  const chooseProfile=(nextProfileId:string)=>{setProfileId(nextProfileId);const profile=profiles.find(item=>item.id===nextProfileId);if(profile?.poolId){const nextPool=pools.find(item=>item.id===profile.poolId&&item.enabled);if(nextPool){setRouterId(nextPool.routerId);setInterfaceId(nextPool.interfaceId);setPoolId(nextPool.id)}}setQuotaEnabled(Boolean(profile?.quotaBytes));setBandwidthMode("default");setExpirationMode(profile?.expirationDays?"date":"never")};

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}>
    <section className="dialog dialog-wide" role="dialog" aria-modal="true" aria-labelledby="new-peer-title">
      <header className="dialog-header"><div><h2 id="new-peer-title">Create WireGuard peer</h2><p>Address allocation is locked in PostgreSQL, rechecked on MikroTik, then committed with the peer.</p></div><button className="button button-ghost icon-button" type="button" onClick={close} aria-label="Close peer form"><X /></button></header>
      <form onSubmit={async (event) => {
        event.preventDefault(); setLoading(true); setError("");
        const form = new FormData(event.currentTarget);
        try {
          const result = await api<{ id: string }>("/api/peers", { method: "POST", body: JSON.stringify({
            routerId, interfaceId, poolId: pool?.id, assignmentMode,
            requestedIp: assignmentMode === "manual" ? form.get("requestedIp") : undefined,
            name: form.get("name"), description: form.get("description"), clientAllowedIps: form.get("clientAllowedIps"),
            dnsServer: form.get("dnsServer"), persistentKeepalive: Number(form.get("persistentKeepalive")), mtu: Number(form.get("mtu")),
            endpointOverride: form.get("endpointOverride") || null,
            endpointPortOverride: form.get("endpointPortOverride") ? Number(form.get("endpointPortOverride")) : null,
            expiresAt: expirationMode === "date" && form.get("expiresAt") ? new Date(String(form.get("expiresAt"))).toISOString() : null,
            usePresharedKey: form.get("usePresharedKey") === "on", quotaEnabled,
            quotaValue: quotaEnabled ? Number(form.get("quotaValue")) : null, quotaUnit: form.get("quotaUnit") || "GB", quotaPeriod: form.get("quotaPeriod") || "monthly",
            profileId:profileId||null,bandwidthMode,downloadLimitMbps:bandwidthMode==="custom"?Number(downloadMbps):null,uploadLimitMbps:bandwidthMode==="custom"?Number(uploadMbps):null,
            burstDownloadMbps:form.get("burstDownloadMbps")?Number(form.get("burstDownloadMbps")):null,burstUploadMbps:form.get("burstUploadMbps")?Number(form.get("burstUploadMbps")):null,burstTimeSeconds:form.get("burstTimeSeconds")?Number(form.get("burstTimeSeconds")):null,
          }) });
          router.push(`/peers/${result.id}`); router.refresh();
        } catch (caught) { setError(caught instanceof Error ? caught.message : "Create failed"); }
        finally { setLoading(false); }
      }}>
        <div className="dialog-body form">
          <fieldset className="form-section"><legend>User</legend><div className="form-grid">
            <Field name="name" label="Name" placeholder="Example User" />
            <div className="form-group span-2"><label className="label" htmlFor="peer-comment">Comment <span className="hint">(optional)</span></label><textarea id="peer-comment" className="field" name="description" rows={2} maxLength={500} placeholder="Sample subscriber device" /><div className="hint">Stored locally and synchronized to the MikroTik peer comment.</div></div>
          </div></fieldset>

          <fieldset className="form-section"><legend>Profile</legend><div className="form-grid"><div className="form-group span-2"><label className="label" htmlFor="peer-profile">User profile</label><select id="peer-profile" className="field" value={profileId} onChange={event=>chooseProfile(event.target.value)}><option value="">No profile · use router and global defaults</option>{profiles.map(profile=><option value={profile.id} key={profile.id}>{profile.name}</option>)}</select>{selectedProfile&&<div className="hint">{selectedProfile.description||"Reusable subscriber defaults"}. Every field remains overridable.</div>}</div></div></fieldset>

          <fieldset className="form-section"><legend>Router and IP assignment</legend><div className="form-grid">
            <div className="form-group"><label className="label" htmlFor="peer-router">Router</label><select id="peer-router" className="field" value={routerId} onChange={(event) => { setRouterId(event.target.value); chooseInterface(event.target.value); }}>{routers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div>
            <div className="form-group"><label className="label" htmlFor="peer-interface">WireGuard interface</label><select id="peer-interface" className="field" value={interfaceId} onChange={(event) => { setInterfaceId(event.target.value); setPoolId(pools.find((item) => item.interfaceId === event.target.value && item.enabled)?.id || ""); }}>{interfaceOptions.map((item) => <option value={item.id} key={item.id}>{item.name}{item.addresses.length ? ` · ${item.addresses.join(", ")}` : ""}</option>)}</select></div>
            <div className="form-group span-2"><label className="label" htmlFor="peer-pool">WireGuard pool</label><select id="peer-pool" className="field" value={pool?.id || ""} onChange={(event) => setPoolId(event.target.value)} required>{poolOptions.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.available}/{item.total} available</option>)}</select>{pool ? <div className="pool-preview"><div><strong>{pool.name}</strong><span className="mono">{pool.network} · {pool.startIp} – {pool.endIp}</span></div><div><strong>{pool.available} / {pool.total}</strong><span>Available · {pool.total-pool.available} used or reserved</span></div><div><strong className="mono">{pool.nextIp || "None"}</strong><span>Estimated next IP</span></div></div> : <div className="form-message form-message-error">Create or enable a WireGuard pool for this interface before provisioning a peer.</div>}</div>
            <fieldset className="form-group span-2 choice-group"><legend>IP assignment</legend><label><input type="radio" name="assignmentMode" value="automatic" checked={assignmentMode === "automatic"} onChange={() => setAssignmentMode("automatic")} />Automatic from pool</label><label><input type="radio" name="assignmentMode" value="manual" checked={assignmentMode === "manual"} onChange={() => setAssignmentMode("manual")} />Manual</label></fieldset>
            {assignmentMode === "manual" && <div className="form-group span-2"><label className="label" htmlFor="manual-client-ip">Manual IP</label><input id="manual-client-ip" className="field mono" name="requestedIp" placeholder={pool?.nextIp || "10.20.30.50"} required /><div className="hint">Blocked if PostgreSQL, a reservation, or a live MikroTik allowed-address owns this IP.</div></div>}
          </div></fieldset>

          <fieldset className="form-section"><legend>Bandwidth</legend><div className="form-grid"><div className="form-group"><label className="label" htmlFor="bandwidth-mode">Policy</label><select id="bandwidth-mode" className="field" value={bandwidthMode} onChange={event=>setBandwidthMode(event.target.value as typeof bandwidthMode)}><option value="default">Use inherited default</option><option value="unlimited">Unlimited</option><option value="custom">Custom</option></select></div>{bandwidthMode==="custom"&&<><label className="form-group"><span className="label">Maximum download</span><div className="input-pair"><input className="field" value={downloadMbps} onChange={event=>setDownloadMbps(event.target.value)} type="number" min="0.001" step="0.001" required/><span className="field input-suffix">Mbps</span></div></label><label className="form-group"><span className="label">Maximum upload</span><div className="input-pair"><input className="field" value={uploadMbps} onChange={event=>setUploadMbps(event.target.value)} type="number" min="0.001" step="0.001" required/><span className="field input-suffix">Mbps</span></div></label><details className="advanced-settings span-2"><summary><span><strong>Advanced bandwidth settings</strong><small>Optional RouterOS burst limit and duration</small></span></summary><div className="form-grid advanced-settings-body"><Field name="burstDownloadMbps" label="Burst download Mbps" type="number" optional/><Field name="burstUploadMbps" label="Burst upload Mbps" type="number" optional/><Field name="burstTimeSeconds" label="Burst time seconds" type="number" optional/></div></details></>}<div className="effective-source span-2"><strong>{effectiveBandwidth.label}</strong><span>Inherited from: {effectiveBandwidth.source}</span></div></div></fieldset>

          <fieldset className="form-section"><legend>Traffic limit</legend><div className="form-grid">
            <div className="form-group"><label className="label" htmlFor="traffic-mode">Usage policy</label><select id="traffic-mode" className="field" value={quotaEnabled ? "custom" : "unlimited"} onChange={(event) => setQuotaEnabled(event.target.value === "custom")}><option value="unlimited">Unlimited</option><option value="custom">Custom</option></select></div>
            {quotaEnabled && <><div className="form-group"><label className="label" htmlFor="quota-value">Limit</label><div className="input-pair"><input key={`quota-${profileId}-${routerId}`} id="quota-value" className="field" name="quotaValue" type="number" min="0.001" max="1000000" step="0.001" defaultValue={bytesToGb(selectedProfile?.quotaBytes||selectedRouter?.defaultQuotaBytes)} required /><select className="field" name="quotaUnit" aria-label="Traffic limit unit" defaultValue="GB"><option>MB</option><option>GB</option><option>TB</option></select></div></div><div className="form-group span-2"><label className="label" htmlFor="quota-period">Quota period</label><select key={`period-${profileId}-${routerId}`} id="quota-period" className="field" name="quotaPeriod" defaultValue={selectedProfile?.quotaPeriod||selectedRouter?.defaultQuotaPeriod||"monthly"}><option value="one_time">Total</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></div></>}
          </div></fieldset>

          <fieldset className="form-section"><legend>Expiration</legend><div className="form-grid">
            <div className="form-group"><label className="label" htmlFor="expiration-mode">Expiration</label><select id="expiration-mode" className="field" value={expirationMode} onChange={(event) => setExpirationMode(event.target.value as "never" | "date")}><option value="never">Never</option><option value="date">Date</option></select></div>
            {expirationMode === "date" && <Field name="expiresAt" label="Expires at" type="datetime-local" value={futureLocalDate(selectedProfile?.expirationDays||selectedRouter?.defaultExpirationDays)} key={`expiry-${profileId}-${routerId}`}/>} 
          </div></fieldset>

          <details className="advanced-settings">
            <summary><span><strong>Advanced settings</strong><small>Client routing, DNS, endpoint, MTU, keepalive, and pre-shared key</small></span></summary>
            <div className="form-grid advanced-settings-body">
              <Field name="dnsServer" label="DNS" value={effectiveDns} key={`dns-${profileId}-${routerId}-${pool?.id}`} mono />
              <Field name="clientAllowedIps" label="AllowedIPs" value={effectiveAllowed} key={`allowed-${profileId}-${routerId}-${pool?.id}`} mono />
              <Field name="persistentKeepalive" label="Persistent keepalive" value={String(effectiveKeepalive)} key={`keepalive-${profileId}-${routerId}-${pool?.id}`} type="number" />
              <Field name="mtu" label="MTU" value={String(effectiveMtu)} key={`mtu-${profileId}-${routerId}-${pool?.id}`} type="number" />
              <Field name="endpointOverride" label="Endpoint override" placeholder="vpn.example.net" value={selectedRouter?.defaultEndpoint||""} key={`endpoint-${routerId}`} mono optional />
              <Field name="endpointPortOverride" label="Endpoint port override" placeholder="13231" type="number" optional />
              <div className="form-group span-2"><div className="checkbox"><input id="psk" name="usePresharedKey" type="checkbox" /><label htmlFor="psk">Add a pre-shared key</label></div>{pool?.endpoint && <div className="hint">Inherited endpoint: <span className="mono">{pool.endpoint}</span>. Overrides apply only to this peer.</div>}</div>
            </div>
          </details>
          <section className="effective-preview" aria-label="Effective configuration"><h3>Effective configuration</h3><dl><div><dt>IP</dt><dd className="mono">{assignmentMode==="manual"?"Manual address entered above":pool?.nextIp||"No address available"}</dd></div><div><dt>Endpoint</dt><dd className="mono">{selectedRouter?.defaultEndpoint||pool?.endpoint||"Router endpoint"}</dd></div><div><dt>Bandwidth</dt><dd>{effectiveBandwidth.label}<span>{effectiveBandwidth.source}</span></dd></div><div><dt>Traffic limit</dt><dd>{quotaEnabled?"Custom quota":"Unlimited"}</dd></div><div><dt>Expiration</dt><dd>{expirationMode==="date"?"Selected date":"Never"}</dd></div></dl></section>
          {error && <div className="form-message form-message-error" role="alert">{error}</div>}
        </div>
        <footer className="dialog-footer"><button type="button" className="button" onClick={close}>Cancel</button><button className="button button-primary" disabled={loading || !pool}>{loading ? <LoaderCircle className="spin" /> : <Save />}{loading ? "Creating and verifying…" : "Create peer"}</button></footer>
      </form>
    </section>
  </div>;
}

function bandwidthLabel(download:string|null|undefined,upload:string|null|undefined){if(!download||!upload)return"Unlimited";return`${formatRate(download)} ↓ / ${formatRate(upload)} ↑`}function formatRate(value:string){const amount=Number(value);return amount>=1e9?`${amount/1e9} Gbps`:amount>=1e6?`${amount/1e6} Mbps`:`${amount/1e3} Kbps`}
function bytesToGb(value:string|null|undefined){return value?String(Number(value)/1e9):""}function futureLocalDate(days:number|null|undefined){if(!days)return"";const date=new Date(Date.now()+days*86400000);date.setMinutes(date.getMinutes()-date.getTimezoneOffset());return date.toISOString().slice(0,16)}

function Field({ name, label, value = "", placeholder, type = "text", mono = false, optional = false }: { name: string; label: string; value?: string; placeholder?: string; type?: string; mono?: boolean; optional?: boolean }) {
  const id = `peer-${name}`;
  return <div className="form-group"><label className="label" htmlFor={id}>{label}{optional && <span className="hint"> (optional)</span>}</label><input id={id} className={`field ${mono ? "mono" : ""}`} name={name} defaultValue={value} placeholder={placeholder} type={type} required={!optional} /></div>;
}
