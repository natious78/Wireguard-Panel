import { createHash } from "node:crypto";
import type { RemoteWireGuardInterface, RemoteWireGuardPeer } from "./types";

export function rosBoolean(value: unknown) {
  return value === true || value === "true" || value === "yes";
}

export function rosNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function rosBigInt(value: unknown) {
  try { return BigInt(String(value ?? "0").trim() || "0"); }
  catch { return 0n; }
}

export function parseRouterDurationSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  const tokenPattern = /(\d+(?:\.\d+)?)(ms|w|d|h|m|s)/g;
  const factors: Record<string, number> = { ms: .001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  let total = 0;
  let consumed = "";
  for (const match of raw.matchAll(tokenPattern)) {
    consumed += match[0];
    total += Number(match[1]) * factors[match[2]];
  }
  if (consumed === raw && Number.isFinite(total)) return total;

  const clock = raw.match(/^(?:(\d+)w)?(?:(\d+)d)?(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d+))?$/);
  if (!clock) return null;
  const [,weeks="0",days="0",hours="0",minutes="0",seconds="0",fraction="0"] = clock;
  return Number(weeks)*604800+Number(days)*86400+Number(hours)*3600+Number(minutes)*60+Number(seconds)+Number(`0.${fraction}`);
}

export function parseRouterDate(value: unknown, observedAt = new Date()): Date | null {
  if (!value || value === "never") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();
  const duration = parseRouterDurationSeconds(raw);
  if (duration !== null) return new Date(observedAt.getTime() - duration * 1000);
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;

  const match = raw.match(/^(\w{3})\/(\d{1,2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/i);
  if (!match) return null;
  const months: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const month = months[match[1].toLowerCase()];
  if (month === undefined) return null;
  return new Date(Date.UTC(Number(match[3]), month, Number(match[2]), Number(match[4]), Number(match[5]), Number(match[6])));
}

export function normalizeInterface(row: Record<string, unknown>): RemoteWireGuardInterface {
  return {
    id: String(row[".id"] ?? row.id ?? ""),
    name: String(row.name ?? ""),
    listenPort: rosNumber(row["listen-port"]),
    mtu: rosNumber(row.mtu, 1420),
    publicKey: String(row["public-key"] ?? ""),
    running: rosBoolean(row.running),
    disabled: rosBoolean(row.disabled),
  };
}

export function normalizePeer(row: Record<string, unknown>, observedAt = new Date()): RemoteWireGuardPeer {
  const rawHandshake = row["last-handshake"] ?? row["latest-handshake"];
  const rawHandshakeText = rawHandshake === undefined || rawHandshake === null || String(rawHandshake).trim() === "" ? null : String(rawHandshake).trim();
  const parsedHandshake = parseRouterDate(rawHandshakeText, observedAt);
  return {
    id: String(row[".id"] ?? row.id ?? ""),
    interfaceName: String(row.interface ?? ""),
    name: String(row.name ?? row.comment ?? "Unnamed peer"),
    comment: String(row.comment ?? ""),
    publicKey: String(row["public-key"] ?? ""),
    allowedAddress: String(row["allowed-address"] ?? ""),
    endpointAddress: row["endpoint-address"] ? String(row["endpoint-address"]) : null,
    endpointPort: row["endpoint-port"] ? rosNumber(row["endpoint-port"]) : null,
    persistentKeepalive: rosNumber(row["persistent-keepalive"]),
    disabled: rosBoolean(row.disabled),
    lastHandshakeAt: parsedHandshake,
    lastHandshakeRaw: rawHandshakeText,
    lastHandshakeParseValid: rawHandshakeText === null || parsedHandshake !== null,
    rxBytes: rosBigInt(row.rx ?? row["rx-byte"] ?? row["rx-bytes"]),
    txBytes: rosBigInt(row.tx ?? row["tx-byte"] ?? row["tx-bytes"]),
  };
}

export function remotePeerFingerprint(peer: RemoteWireGuardPeer) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        interfaceName: peer.interfaceName,
        comment: peer.comment,
        publicKey: peer.publicKey,
        allowedAddress: peer.allowedAddress,
        endpointAddress: peer.endpointAddress,
        endpointPort: peer.endpointPort,
        persistentKeepalive: peer.persistentKeepalive,
        disabled: peer.disabled,
      }),
    )
    .digest("hex");
}

export function remoteInterfaceFingerprint(item: RemoteWireGuardInterface) {
  return createHash("sha256")
    .update(JSON.stringify({ name: item.name, listenPort: item.listenPort, mtu: item.mtu, publicKey: item.publicKey, disabled: item.disabled }))
    .digest("hex");
}

export function versionSupportsWireGuard(version: string) {
  const major = Number(version.match(/^(\d+)/)?.[1] ?? 0);
  return major >= 7;
}
