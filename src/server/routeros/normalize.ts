import { createHash } from "node:crypto";
import type { RemoteWireGuardInterface, RemoteWireGuardPeer } from "./types";

export function rosBoolean(value: unknown) {
  return value === true || value === "true" || value === "yes";
}

export function rosNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseRouterDate(value: unknown): Date | null {
  if (!value || value === "never") return null;
  if (value instanceof Date) return value;
  const raw = String(value);
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

export function normalizePeer(row: Record<string, unknown>): RemoteWireGuardPeer {
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
    lastHandshakeAt: parseRouterDate(row["last-handshake"]),
    rxBytes: BigInt(String(row.rx ?? row["rx-byte"] ?? row["rx-bytes"] ?? 0)),
    txBytes: BigInt(String(row.tx ?? row["tx-byte"] ?? row["tx-bytes"] ?? 0)),
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
