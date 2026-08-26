export class IpAllocationError extends Error { readonly code = "IP_ALLOCATION"; }

export type Ipv4Network = { cidr:string;prefix:number;network:string;broadcast:string;networkNumber:number;broadcastNumber:number;size:number;family:4 };

export function ipv4ToNumber(ip:string) {
  const parts = ip.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) throw new IpAllocationError(`'${ip}' is not a valid IPv4 address.`);
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}

export function numberToIpv4(value:number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new IpAllocationError("IPv4 value is outside the valid range.");
  return [24,16,8,0].map((shift) => Math.floor(value / 2 ** shift) & 255).join(".");
}

export function normalizeClientIp(value:string) { return value.trim().split("/")[0]; }

export function parseIpv4Cidr(value:string):Ipv4Network {
  const [address,prefixRaw,...extra] = value.trim().split("/");
  if (extra.length || prefixRaw === undefined || !/^(?:\d|[12]\d|3[0-2])$/.test(prefixRaw)) throw new IpAllocationError(`'${value}' is not a valid IPv4 CIDR.`);
  const prefix = Number(prefixRaw);
  const ip = ipv4ToNumber(address);
  const size = 2 ** (32 - prefix);
  const networkNumber = Math.floor(ip / size) * size;
  const broadcastNumber = networkNumber + size - 1;
  return { family:4,cidr:`${numberToIpv4(networkNumber)}/${prefix}`,prefix,network:numberToIpv4(networkNumber),broadcast:numberToIpv4(broadcastNumber),networkNumber,broadcastNumber,size };
}

export function ipv4InCidr(ip:string,cidr:string) { const value=ipv4ToNumber(normalizeClientIp(ip));const network=parseIpv4Cidr(cidr);return value>=network.networkNumber&&value<=network.broadcastNumber; }
export function cidrContainsIp(cidr:string,ip:string) { try { return ipv4InCidr(ip,cidr); } catch { return false; } }
export function cidrsOverlap(left:string,right:string) { const a=parseIpv4Cidr(left),b=parseIpv4Cidr(right);return a.networkNumber<=b.broadcastNumber&&b.networkNumber<=a.broadcastNumber; }

export function ipv4Range(start:string,end:string) {
  const first=ipv4ToNumber(normalizeClientIp(start));const last=ipv4ToNumber(normalizeClientIp(end));
  if(first>last)throw new IpAllocationError("The pool start must be before the pool end.");
  return {start:first,end:last,total:last-first+1};
}

export function rangesOverlap(aStart:string,aEnd:string,bStart:string,bEnd:string) {
  const a=ipv4Range(aStart,aEnd),b=ipv4Range(bStart,bEnd);return a.start<=b.end&&b.start<=a.end;
}

export function validatePoolRange(cidr:string,gateway:string,start:string,end:string) {
  const network=parseIpv4Cidr(cidr);const gatewayNumber=ipv4ToNumber(gateway);const range=ipv4Range(start,end);
  for(const [label,value] of [["Gateway/router",gatewayNumber],["Start IP",range.start],["End IP",range.end]] as const) if(value<network.networkNumber||value>network.broadcastNumber) throw new IpAllocationError(`${label} is outside ${network.cidr}.`);
  if(range.start===network.networkNumber||range.end===network.networkNumber)throw new IpAllocationError("The network address cannot be part of the client range.");
  if(network.prefix<32&&(range.start===network.broadcastNumber||range.end===network.broadcastNumber))throw new IpAllocationError("The broadcast address cannot be part of the client range.");
  if(gatewayNumber>=range.start&&gatewayNumber<=range.end)throw new IpAllocationError("The router/interface address must be excluded from the client range.");
  return {network,range,gateway:numberToIpv4(gatewayNumber)};
}

export function allowedAddressOwnsIp(allowedAddresses:string,ip:string) {
  return allowedAddresses.split(",").some((value) => { const trimmed=value.trim();if(!trimmed)return false;if(!trimmed.includes("/"))return normalizeClientIp(trimmed)===normalizeClientIp(ip);return cidrContainsIp(trimmed,ip); });
}

export function parseAllowedAddresses(value:string) {
  return value.split(",").map((item)=>item.trim()).filter(Boolean).map((item)=>item.includes("/")?parseIpv4Cidr(item):parseIpv4Cidr(`${item}/32`));
}

export function suggestPoolFromInterfaceAddress(address:string) {
  const network=parseIpv4Cidr(address);if(network.prefix>30)return null;
  const gateway=normalizeClientIp(address);let start=network.networkNumber+1;if(start===ipv4ToNumber(gateway))start+=1;let end=network.broadcastNumber-1;if(end===ipv4ToNumber(gateway))end-=1;
  if(start>end)return null;
  return {network:network.cidr,gateway,startIp:numberToIpv4(start),endIp:numberToIpv4(end)};
}

export function compareIpAddresses(a:string|null|undefined,b:string|null|undefined) {
  const parse=(value:string|null|undefined)=>{const raw=String(value??"").trim().split(",")[0]?.trim()??"";try{const network=raw.includes(":")?null:parseIpv4Cidr(raw.includes("/")?raw:`${raw}/32`);return{valid:Boolean(network),number:network?.networkNumber??0,prefix:network?.prefix??Number.MAX_SAFE_INTEGER,raw}}catch{return{valid:false,number:0,prefix:Number.MAX_SAFE_INTEGER,raw}}};
  const left=parse(a),right=parse(b);
  if(left.valid!==right.valid)return left.valid?-1:1;
  if(!left.valid&&!right.valid)return left.raw.localeCompare(right.raw,undefined,{numeric:true,sensitivity:"base"});
  return left.number-right.number||left.prefix-right.prefix;
}
