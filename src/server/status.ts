import { env } from "@/lib/env";

export type PeerStatus = "online" | "recent" | "offline" | "never" | "disabled" | "expired" | "traffic_limit_reached" | "router_unreachable";

export function peerStatus(peer: { disabled: boolean; remote_disabled?: boolean | null; expired: boolean; last_handshake_at: Date | string | null; quota_reached_at?: Date | string | null; router_stats_status?: string | null }, now = new Date(), thresholds = { onlineSeconds: env().ONLINE_THRESHOLD_SECONDS, recentSeconds: env().RECENT_THRESHOLD_SECONDS }): PeerStatus {
  if (peer.expired) return "expired";
  if (peer.quota_reached_at) return "traffic_limit_reached";
  if (peer.disabled || peer.remote_disabled) return "disabled";
  if (peer.router_stats_status === "unreachable") return "router_unreachable";
  if (!peer.last_handshake_at) return "never";
  const timestamp = new Date(peer.last_handshake_at).getTime();
  if (!Number.isFinite(timestamp)) return "never";
  const age = Math.max(0,(now.getTime() - timestamp) / 1000);
  if (age <= thresholds.onlineSeconds) return "online";
  if (age <= thresholds.recentSeconds) return "recent";
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
