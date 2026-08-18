export class IpAllocationError extends Error {}

export function ipv4ToNumber(ip: string) {
  const parts = ip.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) {
    throw new IpAllocationError(`'${ip}' is not a valid IPv4 address.`);
  }
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

export function numberToIpv4(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new IpAllocationError("IPv4 value is outside the valid range.");
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) & 255).join(".");
}

export function normalizeClientIp(value: string) {
  return value.trim().split("/")[0];
}

export function allocateClientIp(poolStart: string, poolEnd: string, usedAddresses: Iterable<string>, requested?: string) {
  const start = ipv4ToNumber(normalizeClientIp(poolStart));
  const end = ipv4ToNumber(normalizeClientIp(poolEnd));
  if (start > end) throw new IpAllocationError("The client pool start must be before the pool end.");
  const used = new Set([...usedAddresses].map((address) => normalizeClientIp(address)));
  if (requested) {
    const normalized = normalizeClientIp(requested);
    const candidate = ipv4ToNumber(normalized);
    if (candidate < start || candidate > end) throw new IpAllocationError(`${normalized} is outside this interface's client pool.`);
    if (used.has(normalized)) throw new IpAllocationError(`${normalized} is already assigned to another peer.`);
    return normalized;
  }
  for (let candidate = start; candidate <= end; candidate += 1) {
    const value = numberToIpv4(candidate);
    if (!used.has(value)) return value;
  }
  throw new IpAllocationError("No client addresses are available in this interface's pool.");
}

export function poolStats(poolStart: string | null, poolEnd: string | null, usedAddresses: Iterable<string>) {
  if (!poolStart || !poolEnd) return { total: 0, used: 0, available: 0 };
  const start = ipv4ToNumber(poolStart);
  const end = ipv4ToNumber(poolEnd);
  const total = Math.max(0, end - start + 1);
  const used = new Set([...usedAddresses].map(normalizeClientIp)).size;
  return { total, used, available: Math.max(0, total - used) };
}
