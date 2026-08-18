"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Save, X } from "lucide-react";
import { api } from "@/lib/client-api";

type RouterOption = { id: string; name: string };
type InterfaceOption = { id: string; name: string; routerId: string; routerName: string; addresses: string[] };
type PoolOption = {
  id: string; name: string; routerId: string; interfaceId: string; network: string; startIp: string; endIp: string;
  dns: string; clientAllowedIps: string; endpoint: string; mtu: number; persistentKeepalive: number;
  total: number; available: number; nextIp: string | null; enabled: boolean;
};

export function PeerCreateDialog({ routers, interfaces, pools }: { routers: RouterOption[]; interfaces: InterfaceOption[]; pools: PoolOption[] }) {
  const router = useRouter();
  const [routerId, setRouterId] = useState(routers[0]?.id || "");
  const interfaceOptions = useMemo(() => interfaces.filter((item) => item.routerId === routerId), [interfaces, routerId]);
  const [interfaceId, setInterfaceId] = useState(interfaceOptions[0]?.id || "");
  const poolOptions = useMemo(() => pools.filter((item) => item.interfaceId === interfaceId && item.enabled), [pools, interfaceId]);
  const [poolId, setPoolId] = useState(poolOptions[0]?.id || "");
  const pool = poolOptions.find((item) => item.id === poolId) || poolOptions[0];
  const [assignmentMode, setAssignmentMode] = useState<"automatic" | "manual">("automatic");
  const [quotaEnabled, setQuotaEnabled] = useState(false);
  const [expirationMode, setExpirationMode] = useState<"never" | "date">("never");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const close = () => router.push("/peers");

  const chooseInterface = (nextRouter: string) => {
    const nextInterface = interfaces.find((item) => item.routerId === nextRouter)?.id || "";
    setInterfaceId(nextInterface);
    setPoolId(pools.find((item) => item.interfaceId === nextInterface && item.enabled)?.id || "");
  };

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
            expiresAt: expirationMode === "date" && form.get("expiresAt") ? new Date(String(form.get("expiresAt"))).toISOString() : null,
            usePresharedKey: form.get("usePresharedKey") === "on", quotaEnabled,
            quotaValue: quotaEnabled ? Number(form.get("quotaValue")) : null, quotaUnit: form.get("quotaUnit") || "GB", quotaPeriod: form.get("quotaPeriod") || "monthly",
          }) });
          router.push(`/peers/${result.id}`); router.refresh();
        } catch (caught) { setError(caught instanceof Error ? caught.message : "Create failed"); }
        finally { setLoading(false); }
      }}>
        <div className="dialog-body form">
          <fieldset className="form-section"><legend>User</legend><div className="form-grid">
            <Field name="name" label="Name" placeholder="Amir" />
            <div className="form-group span-2"><label className="label" htmlFor="peer-comment">Comment <span className="hint">(optional)</span></label><textarea id="peer-comment" className="field" name="description" rows={2} maxLength={500} placeholder="Accounting Office Laptop" /><div className="hint">Stored locally and synchronized to the MikroTik peer comment.</div></div>
          </div></fieldset>

          <fieldset className="form-section"><legend>Router and IP assignment</legend><div className="form-grid">
            <div className="form-group"><label className="label" htmlFor="peer-router">Router</label><select id="peer-router" className="field" value={routerId} onChange={(event) => { setRouterId(event.target.value); chooseInterface(event.target.value); }}>{routers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div>
            <div className="form-group"><label className="label" htmlFor="peer-interface">WireGuard interface</label><select id="peer-interface" className="field" value={interfaceId} onChange={(event) => { setInterfaceId(event.target.value); setPoolId(pools.find((item) => item.interfaceId === event.target.value && item.enabled)?.id || ""); }}>{interfaceOptions.map((item) => <option value={item.id} key={item.id}>{item.name}{item.addresses.length ? ` · ${item.addresses.join(", ")}` : ""}</option>)}</select></div>
            <div className="form-group span-2"><label className="label" htmlFor="peer-pool">WireGuard pool</label><select id="peer-pool" className="field" value={pool?.id || ""} onChange={(event) => setPoolId(event.target.value)} required>{poolOptions.map((item) => <option value={item.id} key={item.id}>{item.name} · {item.available}/{item.total} available</option>)}</select>{pool ? <div className="pool-preview"><div><strong>{pool.name}</strong><span className="mono">{pool.startIp} – {pool.endIp}</span></div><div><strong>{pool.available} / {pool.total}</strong><span>Available</span></div><div><strong className="mono">{pool.nextIp || "None"}</strong><span>Estimated next IP</span></div></div> : <div className="form-message form-message-error">Create or enable a WireGuard pool for this interface before provisioning a peer.</div>}</div>
            <fieldset className="form-group span-2 choice-group"><legend>IP assignment</legend><label><input type="radio" name="assignmentMode" value="automatic" checked={assignmentMode === "automatic"} onChange={() => setAssignmentMode("automatic")} />Automatic from pool</label><label><input type="radio" name="assignmentMode" value="manual" checked={assignmentMode === "manual"} onChange={() => setAssignmentMode("manual")} />Manual</label></fieldset>
            {assignmentMode === "manual" && <div className="form-group span-2"><label className="label" htmlFor="manual-client-ip">Manual IP</label><input id="manual-client-ip" className="field mono" name="requestedIp" placeholder={pool?.nextIp || "10.20.30.50"} required /><div className="hint">Blocked if PostgreSQL, a reservation, or a live MikroTik allowed-address owns this IP.</div></div>}
          </div></fieldset>

          <fieldset className="form-section"><legend>Traffic limit</legend><div className="form-grid">
            <div className="form-group"><label className="label" htmlFor="traffic-mode">Usage policy</label><select id="traffic-mode" className="field" value={quotaEnabled ? "custom" : "unlimited"} onChange={(event) => setQuotaEnabled(event.target.value === "custom")}><option value="unlimited">Unlimited</option><option value="custom">Custom</option></select></div>
            {quotaEnabled && <><div className="form-group"><label className="label" htmlFor="quota-value">Limit</label><div className="input-pair"><input id="quota-value" className="field" name="quotaValue" type="number" min="0.001" max="1000000" step="0.001" required /><select className="field" name="quotaUnit" aria-label="Traffic limit unit" defaultValue="GB"><option>MB</option><option>GB</option><option>TB</option></select></div></div><div className="form-group span-2"><label className="label" htmlFor="quota-period">Quota period</label><select id="quota-period" className="field" name="quotaPeriod" defaultValue="monthly"><option value="one_time">Total</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></div></>}
          </div></fieldset>

          <fieldset className="form-section"><legend>Expiration and client defaults</legend><div className="form-grid">
            <div className="form-group"><label className="label" htmlFor="expiration-mode">Expiration</label><select id="expiration-mode" className="field" value={expirationMode} onChange={(event) => setExpirationMode(event.target.value as "never" | "date")}><option value="never">Never</option><option value="date">Date</option></select></div>
            {expirationMode === "date" && <Field name="expiresAt" label="Expires at" type="datetime-local" />}
            <Field name="dnsServer" label="DNS" value={pool?.dns || "1.1.1.1"} key={`dns-${pool?.id}`} mono />
            <Field name="clientAllowedIps" label="AllowedIPs" value={pool?.clientAllowedIps || "0.0.0.0/0"} key={`allowed-${pool?.id}`} mono />
            <Field name="persistentKeepalive" label="Persistent keepalive" value={String(pool?.persistentKeepalive ?? 25)} key={`keepalive-${pool?.id}`} type="number" />
            <Field name="mtu" label="MTU" value={String(pool?.mtu ?? 1420)} key={`mtu-${pool?.id}`} type="number" />
            <div className="form-group span-2"><div className="checkbox"><input id="psk" name="usePresharedKey" type="checkbox" /><label htmlFor="psk">Add a pre-shared key</label></div>{pool?.endpoint && <div className="hint">Endpoint from pool: <span className="mono">{pool.endpoint}</span></div>}</div>
          </div></fieldset>
          {error && <div className="form-message form-message-error" role="alert">{error}</div>}
        </div>
        <footer className="dialog-footer"><button type="button" className="button" onClick={close}>Cancel</button><button className="button button-primary" disabled={loading || !pool}>{loading ? <LoaderCircle className="spin" /> : <Save />}{loading ? "Creating and verifying…" : "Create peer"}</button></footer>
      </form>
    </section>
  </div>;
}

function Field({ name, label, value = "", placeholder, type = "text", mono = false }: { name: string; label: string; value?: string; placeholder?: string; type?: string; mono?: boolean }) {
  const id = `peer-${name}`;
  return <div className="form-group"><label className="label" htmlFor={id}>{label}</label><input id={id} className={`field ${mono ? "mono" : ""}`} name={name} defaultValue={value} placeholder={placeholder} type={type} required /></div>;
}
