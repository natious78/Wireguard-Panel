"use client";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Columns3,
  Download,
  Eye,
  LoaderCircle,
  Power,
  PowerOff,
  Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import { ConfirmationDialog } from "./confirmation-dialog";
import { HandshakeActivity, QuotaUsage, StatusBadge } from "./ui";

type QuotaPeriod = "one_time" | "daily" | "weekly" | "monthly";
type ColumnKey = "status" | "name" | "comment" | "ip" | "router" | "interface" | "handshake" | "rx" | "tx" | "usage" | "limit" | "expires" | "actions";
type PendingBulk = "disable" | "delete" | null;

const columnOptions: { key: ColumnKey; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "name", label: "Name" },
  { key: "comment", label: "Comment" },
  { key: "ip", label: "IP address" },
  { key: "router", label: "Router" },
  { key: "interface", label: "Interface" },
  { key: "handshake", label: "Last handshake" },
  { key: "rx", label: "RX" },
  { key: "tx", label: "TX" },
  { key: "usage", label: "Usage" },
  { key: "limit", label: "Limit" },
  { key: "expires", label: "Expiration" },
  { key: "actions", label: "Actions" },
];
const defaultColumns = Object.fromEntries(columnOptions.map(({ key }) => [key, true])) as Record<ColumnKey, boolean>;

export type PeerTableRow = {
  id: string;
  name: string;
  description: string | null;
  router_name: string;
  interface_name: string;
  client_ip: string | null;
  public_key: string;
  origin: string;
  status: string;
  last_handshake_at: string | null;
  expires_at: string | null;
  rx: string;
  tx: string;
  currentUsage: string;
  periodUsageBytes: string;
  quotaLimit: string;
  quotaLimitBytes: string | null;
  quotaPeriod: QuotaPeriod | null;
  conflict_type: string | null;
};

export function PeerTable({ rows, sort, queryString }: { rows: PeerTableRow[]; sort: string; queryString: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState<"enable" | "disable" | "delete" | null>(null);
  const [pendingBulk, setPendingBulk] = useState<PendingBulk>(null);
  const [error, setError] = useState("");
  const [columns, setColumns] = useState<Record<ColumnKey, boolean>>(defaultColumns);
  const all = rows.length > 0 && selected.length === rows.length;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("wg-peer-table-columns");
      if (saved) setColumns({ ...defaultColumns, ...JSON.parse(saved) });
    } catch {
      // Invalid or unavailable storage should never prevent the table from rendering.
    }
  }, []);

  function toggleColumn(key: ColumnKey) {
    setColumns((current) => {
      const next = { ...current, [key]: !current[key] };
      try { window.localStorage.setItem("wg-peer-table-columns", JSON.stringify(next)); } catch {}
      return next;
    });
  }

  async function runBulk(action: "enable" | "disable" | "delete") {
    setLoading(action);
    setError("");
    try {
      const result = await api<{ failed: number }>("/api/peers/bulk", {
        method: "POST",
        body: JSON.stringify({ ids: selected, action }),
      });
      if (result.failed) {
        setError(`${result.failed} peer action${result.failed === 1 ? "" : "s"} failed because a router was unavailable or the peer changed remotely.`);
      } else {
        setSelected([]);
      }
      setPendingBulk(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Bulk action failed");
    } finally {
      setLoading(null);
    }
  }

  return (
    <>
      <div className="peer-table-controls">
        <div className="peer-selection-summary" aria-live="polite">
          {selected.length ? <strong>{selected.length} selected</strong> : <span>{rows.length} peers on this page</span>}
        </div>
        {selected.length > 0 && (
          <div className="peer-bulk-actions">
            <button className="button button-small" onClick={() => runBulk("enable")} disabled={Boolean(loading)}>
              {loading === "enable" ? <LoaderCircle className="spin" /> : <Power />}Enable
            </button>
            <button className="button button-small" onClick={() => setPendingBulk("disable")} disabled={Boolean(loading)}><PowerOff />Disable</button>
            <button className="button button-small button-danger" onClick={() => setPendingBulk("delete")} disabled={Boolean(loading)}><Trash2 />Delete</button>
          </div>
        )}
        <details className="column-picker">
          <summary className="button button-small"><Columns3 />Columns</summary>
          <div className="column-picker-menu">
            <strong>Visible columns</strong>
            {columnOptions.map((column) => (
              <label key={column.key}>
                <input type="checkbox" checked={columns[column.key]} onChange={() => toggleColumn(column.key)} />
                {column.label}
              </label>
            ))}
            <button className="button button-small" type="button" onClick={() => {
              setColumns(defaultColumns);
              try { window.localStorage.removeItem("wg-peer-table-columns"); } catch {}
            }}>Reset</button>
          </div>
        </details>
      </div>
      {error && <div className="form-message form-message-error table-message" role="alert">{error}</div>}

      <div className="peer-desktop-table table-wrap">
        <table className="peers-table">
          <thead><tr>
            <th className="peer-col-select"><input type="checkbox" aria-label="Select all peers" checked={all} onChange={(event) => setSelected(event.target.checked ? rows.map((row) => row.id) : [])} /></th>
            {columns.status && <SortTh label="Status" field="status" sort={sort} queryString={queryString} className="peer-col-status" />}
            {columns.name && <SortTh label="Name" field="name" sort={sort} queryString={queryString} className="peer-col-name" />}
            {columns.comment && <th>Comment</th>}
            {columns.ip && <SortTh label="IP address" field="ip" sort={sort} queryString={queryString} />}
            {columns.router && <SortTh label="Router" field="router" sort={sort} queryString={queryString} />}
            {columns.interface && <th>Interface</th>}
            {columns.handshake && <SortTh label="Last handshake" field="handshake" sort={sort} queryString={queryString} />}
            {columns.rx && <SortTh label="RX" field="rx" sort={sort} queryString={queryString} />}
            {columns.tx && <SortTh label="TX" field="tx" sort={sort} queryString={queryString} />}
            {columns.usage && <SortTh label="Usage" field="usage" sort={sort} queryString={queryString} />}
            {columns.limit && <SortTh label="Limit" field="limit" sort={sort} queryString={queryString} />}
            {columns.expires && <SortTh label="Expiration" field="expires" sort={sort} queryString={queryString} />}
            {columns.actions && <th className="peer-col-actions"><span className="sr-only">Actions</span></th>}
          </tr></thead>
          <tbody>{rows.map((peer) => (
            <tr key={peer.id}>
              <td className="peer-col-select"><input type="checkbox" aria-label={`Select ${peer.name}`} checked={selected.includes(peer.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, peer.id] : selected.filter((id) => id !== peer.id))} /></td>
              {columns.status && <td className="peer-col-status"><StatusBadge status={peer.status} /></td>}
              {columns.name && <td className="peer-col-name"><div className="cell-main"><a href={`/peers/${peer.id}`}>{peer.name}</a></div><div className="cell-sub">{peer.origin}{peer.conflict_type && <> · <span className="text-warning">conflict</span></>}</div></td>}
              {columns.comment && <td><span className="peer-comment">{peer.description || "—"}</span></td>}
              {columns.ip && <td className="mono">{peer.client_ip || "—"}</td>}
              {columns.router && <td>{peer.router_name}</td>}
              {columns.interface && <td>{peer.interface_name}</td>}
              {columns.handshake && <td><HandshakeActivity at={peer.last_handshake_at} status={peer.status} /></td>}
              {columns.rx && <td className="mono numeric-cell">{peer.rx}</td>}
              {columns.tx && <td className="mono numeric-cell">{peer.tx}</td>}
              {columns.usage && <td className="peer-usage-cell"><strong>{peer.currentUsage}</strong><QuotaUsage usedBytes={peer.periodUsageBytes} limitBytes={peer.quotaLimitBytes} period={peer.quotaPeriod} compact /></td>}
              {columns.limit && <td><div>{peer.quotaLimit}</div>{peer.quotaPeriod && <div className="cell-sub">{peer.quotaPeriod.replace("one_time", "total")}</div>}</td>}
              {columns.expires && <td>{formatExpiration(peer.expires_at)}</td>}
              {columns.actions && <td className="peer-col-actions"><PeerActions peer={peer} /></td>}
            </tr>
          ))}</tbody>
        </table>
      </div>

      <div className="peer-mobile-records">
        {rows.map((peer) => (
          <article className="peer-mobile-record" key={peer.id}>
            <header>
              <input type="checkbox" aria-label={`Select ${peer.name}`} checked={selected.includes(peer.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, peer.id] : selected.filter((id) => id !== peer.id))} />
              <div><a className="peer-mobile-name" href={`/peers/${peer.id}`}>{peer.name}</a><span>{peer.description || peer.origin}</span></div>
              <StatusBadge status={peer.status} />
            </header>
            <dl className="peer-mobile-facts">
              <div><dt>IP address</dt><dd className="mono">{peer.client_ip || "—"}</dd></div>
              <div><dt>Router / interface</dt><dd>{peer.router_name} / {peer.interface_name}</dd></div>
              <div><dt>Last handshake</dt><dd><HandshakeActivity at={peer.last_handshake_at} status={peer.status} /></dd></div>
              <div><dt>Current usage</dt><dd>{peer.currentUsage}</dd></div>
            </dl>
            <QuotaUsage usedBytes={peer.periodUsageBytes} limitBytes={peer.quotaLimitBytes} period={peer.quotaPeriod} />
            <details className="peer-mobile-secondary">
              <summary>More details</summary>
              <dl>
                <div><dt>RX / TX</dt><dd className="mono">{peer.rx} / {peer.tx}</dd></div>
                <div><dt>Traffic limit</dt><dd>{peer.quotaLimit}{peer.quotaPeriod ? ` · ${peer.quotaPeriod.replace("one_time", "total")}` : ""}</dd></div>
                <div><dt>Expiration</dt><dd>{formatExpiration(peer.expires_at)}</dd></div>
                <div><dt>Origin</dt><dd>{peer.origin}</dd></div>
              </dl>
            </details>
            <footer><PeerActions peer={peer} /></footer>
          </article>
        ))}
      </div>

      {pendingBulk && (
        <ConfirmationDialog
          title={pendingBulk === "delete" ? `Delete ${selected.length} selected peers?` : `Disable ${selected.length} selected peers?`}
          description={pendingBulk === "delete"
            ? "Each peer will be removed from its MikroTik router before its local record and allocated pool address are released."
            : "The selected peers will stop connecting, but their keys, history, and assigned IP addresses will be retained."}
          details={<p>Routers that cannot be reached will cause that peer action to fail safely; affected local records will remain intact.</p>}
          confirmLabel={pendingBulk === "delete" ? "Delete peers" : "Disable peers"}
          tone={pendingBulk === "delete" ? "danger" : "warning"}
          loading={loading === pendingBulk}
          error={error}
          onCancel={() => { setPendingBulk(null); setError(""); }}
          onConfirm={() => runBulk(pendingBulk)}
        />
      )}
    </>
  );
}

function PeerActions({ peer }: { peer: PeerTableRow }) {
  return (
    <div className="table-actions">
      <a className="button button-small icon-button" href={`/peers/${peer.id}`} aria-label={`View ${peer.name}`}><Eye /></a>
      {peer.origin === "managed" && <a className="button button-small icon-button" href={`/api/peers/${peer.id}/config`} aria-label={`Download ${peer.name} configuration`}><Download /></a>}
    </div>
  );
}

function formatExpiration(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Unknown";
}

function SortTh({ label, field, sort, queryString, className }: { label: string; field: string; sort: string; queryString: string; className?: string }) {
  const active = sort.startsWith(`${field}_`);
  const descending = active && sort.endsWith("_desc");
  const next = `${field}_${active && !descending ? "desc" : "asc"}`;
  const href = `/peers?${queryString ? `${queryString}&` : ""}sort=${next}`;
  const Icon = !active ? ArrowUpDown : descending ? ArrowDown : ArrowUp;
  return <th className={className} aria-sort={active ? (descending ? "descending" : "ascending") : "none"}><a className="sort-link" href={href}>{label}<Icon aria-hidden="true" /></a></th>;
}
