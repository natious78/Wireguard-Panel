import { IpAllocationError, ipv4ToNumber, normalizeClientIp, numberToIpv4 } from "@/lib/ip-cidr";

export * from "@/lib/ip-cidr";

export function allocateClientIp(poolStart:string,poolEnd:string,usedAddresses:Iterable<string>,requested?:string) {
  const start=ipv4ToNumber(normalizeClientIp(poolStart));const end=ipv4ToNumber(normalizeClientIp(poolEnd));
  if(start>end)throw new IpAllocationError("The client pool start must be before the pool end.");
  const used=new Set([...usedAddresses].map((address)=>normalizeClientIp(address)));
  if(requested){const normalized=normalizeClientIp(requested);const candidate=ipv4ToNumber(normalized);if(candidate<start||candidate>end)throw new IpAllocationError(`${normalized} is outside this interface's client pool.`);if(used.has(normalized))throw new IpAllocationError(`${normalized} is already assigned to another peer.`);return normalized;}
  for(let candidate=start;candidate<=end;candidate+=1){const value=numberToIpv4(candidate);if(!used.has(value))return value;}
  throw new IpAllocationError("No client addresses are available in this interface's pool.");
}

export function poolStats(poolStart:string|null,poolEnd:string|null,usedAddresses:Iterable<string>) {
  if(!poolStart||!poolEnd)return{total:0,used:0,available:0};
  const start=ipv4ToNumber(poolStart),end=ipv4ToNumber(poolEnd),total=Math.max(0,end-start+1),used=new Set([...usedAddresses].map(normalizeClientIp)).size;
  return{total,used,available:Math.max(0,total-used)};
}
