import { createHash } from "node:crypto";
import { allowedAddressOwnsIp } from "@/lib/ip-cidr";
import type { RemoteSimpleQueue } from "./routeros";

export type BandwidthSource = "peer" | "profile" | "router" | "global" | "unlimited";

export type EffectiveBandwidthPolicy = {
  source: BandwidthSource;
  sourceName: string;
  downloadBps: bigint | null;
  uploadBps: bigint | null;
  burstDownloadBps: bigint | null;
  burstUploadBps: bigint | null;
  burstThresholdDownloadBps: bigint | null;
  burstThresholdUploadBps: bigint | null;
  burstTimeSeconds: number | null;
};

export type DesiredSimpleQueue = {
  name: string;
  target: string;
  maxLimit: string;
  burstLimit: string;
  burstThreshold: string;
  burstTime: string;
  disabled: boolean;
  comment: string;
};

export function queueOwnershipComment(peerId: string) {
  return `wireguard-control:peer:${peerId}`;
}

export function queueName(peerId: string, peerName: string) {
  const safeName = peerName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
  return `wgc-${peerId.slice(0, 8)}${safeName ? `-${safeName}` : ""}`;
}

function rosRate(value: bigint | null) {
  return value && value > 0n ? value.toString() : "0";
}

export function desiredSimpleQueue(peer: { id: string; name: string; clientIp: string }, policy: EffectiveBandwidthPolicy): DesiredSimpleQueue | null {
  if (!policy.downloadBps || !policy.uploadBps) return null;
  const burstConfigured = Boolean(policy.burstDownloadBps && policy.burstUploadBps && policy.burstTimeSeconds);
  return {
    name: queueName(peer.id, peer.name),
    target: `${peer.clientIp}/32`,
    // RouterOS Simple Queue values are upload/download, while the application UI is download/upload.
    maxLimit: `${rosRate(policy.uploadBps)}/${rosRate(policy.downloadBps)}`,
    burstLimit: burstConfigured ? `${rosRate(policy.burstUploadBps)}/${rosRate(policy.burstDownloadBps)}` : "0/0",
    burstThreshold: burstConfigured
      ? `${rosRate(policy.burstThresholdUploadBps ?? policy.uploadBps)}/${rosRate(policy.burstThresholdDownloadBps ?? policy.downloadBps)}`
      : "0/0",
    burstTime: burstConfigured ? `${policy.burstTimeSeconds}s/${policy.burstTimeSeconds}s` : "0s/0s",
    disabled: false,
    comment: queueOwnershipComment(peer.id),
  };
}

export function simpleQueueState(queue: RemoteSimpleQueue | DesiredSimpleQueue) {
  return {
    name: queue.name.trim(),
    target: normalizeQueueTarget(queue.target),
    maxLimit: normalizeRatePair(queue.maxLimit),
    burstLimit: normalizeRatePair(queue.burstLimit),
    burstThreshold: normalizeRatePair(queue.burstThreshold),
    burstTime: normalizeTimePair(queue.burstTime),
    disabled: queue.disabled,
    comment: queue.comment.trim(),
  };
}

export function simpleQueueFingerprint(queue: RemoteSimpleQueue | DesiredSimpleQueue) {
  return createHash("sha256").update(JSON.stringify(simpleQueueState(queue))).digest("hex");
}

export function queueMatchesDesired(queue: RemoteSimpleQueue, desired: DesiredSimpleQueue) {
  return simpleQueueFingerprint(queue) === simpleQueueFingerprint(desired);
}

export function queueTargetsIp(queue: RemoteSimpleQueue, ip: string) {
  return queue.target
    .split(/[;,]/)
    .map((target) => target.trim())
    .filter(Boolean)
    .some((target) => {
      const address = target.split(" ")[0];
      try { return allowedAddressOwnsIp(address, ip); }
      catch { return address === ip; }
    });
}

function normalizeQueueTarget(value: string) {
  return value.split(/[;,]/).map((part) => part.trim()).filter(Boolean).sort().join(",");
}

function normalizeRatePair(value: string) {
  const [upload = "0", download = "0"] = value.trim().split("/");
  return `${normalizeRosRate(upload)}/${normalizeRosRate(download)}`;
}

function normalizeRosRate(value: string) {
  const raw = value.trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)([kmgt]?)$/);
  if (!match) return raw;
  const factors: Record<string, number> = { "": 1, k: 1_000, m: 1_000_000, g: 1_000_000_000, t: 1_000_000_000_000 };
  return String(Math.round(Number(match[1]) * factors[match[2]]));
}

function normalizeTimePair(value: string) {
  const [upload = "0s", download = "0s"] = value.trim().split("/");
  return `${upload.trim().toLowerCase()}/${download.trim().toLowerCase()}`;
}
