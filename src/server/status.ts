import { env } from "@/lib/env";

export type PeerStatus = "online" | "recent" | "offline" | "never" | "disabled" | "expired";

export function peerStatus(peer: { disabled: boolean; expired: boolean; last_handshake_at: Date | string | null }, now = new Date(), thresholds = { onlineSeconds: env().ONLINE_THRESHOLD_SECONDS, recentSeconds: env().RECENT_THRESHOLD_SECONDS }): PeerStatus {
  if (peer.expired) return "expired";
  if (peer.disabled) return "disabled";
  if (!peer.last_handshake_at) return "never";
  const age = (now.getTime() - new Date(peer.last_handshake_at).getTime()) / 1000;
  if (age < thresholds.onlineSeconds) return "online";
  if (age < thresholds.recentSeconds) return "recent";
  return "offline";
}

export function formatBytes(value: bigint | number | string) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / 1024 ** exponent;
  return `${amount >= 10 || exponent === 0 ? amount.toFixed(0) : amount.toFixed(2)} ${units[exponent]}`;
}
