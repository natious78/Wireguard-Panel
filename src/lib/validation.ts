import net from "node:net";
import { z } from "zod";
import { toQuotaBytes } from "@/server/quota";

const optionalText = z.string().trim().max(255).optional().transform((value) => value || undefined);
const quotaFields = {
  quotaEnabled: z.boolean().default(false),
  quotaValue: z.coerce.number().positive().max(1_000_000).nullable().optional(),
  quotaUnit: z.enum(["MB", "GB", "TB"]).default("GB"),
  quotaPeriod: z.enum(["one_time", "daily", "weekly", "monthly"]).default("monthly"),
};
const validateQuota = (value: { quotaEnabled: boolean; quotaValue?: number | null }, context: z.RefinementCtx) => {
  if (value.quotaEnabled && !value.quotaValue) context.addIssue({ code: z.ZodIssueCode.custom, path: ["quotaValue"], message: "Enter a custom traffic limit." });
};

export function quotaBytesFromInput(value: { quotaEnabled: boolean; quotaValue?: number | null; quotaUnit: "MB" | "GB" | "TB" }) {
  return value.quotaEnabled && value.quotaValue ? toQuotaBytes(value.quotaValue, value.quotaUnit) : null;
}

const bandwidthFields = {
  bandwidthMode: z.enum(["default", "unlimited", "custom", "profile"]).default("default"),
  bandwidthProfileId: z.string().uuid().nullable().optional(),
  downloadLimitMbps: z.coerce.number().positive().max(1_000_000).nullable().optional(),
  uploadLimitMbps: z.coerce.number().positive().max(1_000_000).nullable().optional(),
  burstDownloadMbps: z.coerce.number().positive().max(1_000_000).nullable().optional(),
  burstUploadMbps: z.coerce.number().positive().max(1_000_000).nullable().optional(),
  burstTimeSeconds: z.coerce.number().int().min(1).max(3600).nullable().optional(),
};
const updateBandwidthFields={bandwidthMode:z.enum(["default","unlimited","custom","profile"]).optional(),bandwidthProfileId:z.string().uuid().nullable().optional(),downloadLimitMbps:z.coerce.number().positive().max(1_000_000).nullable().optional(),uploadLimitMbps:z.coerce.number().positive().max(1_000_000).nullable().optional(),burstDownloadMbps:z.coerce.number().positive().max(1_000_000).nullable().optional(),burstUploadMbps:z.coerce.number().positive().max(1_000_000).nullable().optional(),burstTimeSeconds:z.coerce.number().int().min(1).max(3600).nullable().optional()};

const validateBandwidth = (value: { bandwidthMode?: string; bandwidthProfileId?: string | null; downloadLimitMbps?: number | null; uploadLimitMbps?: number | null }, context: z.RefinementCtx) => {
  if (value.bandwidthMode === "custom" && (!value.downloadLimitMbps || !value.uploadLimitMbps)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["downloadLimitMbps"], message: "Custom bandwidth requires both download and upload limits." });
  }
  if (value.bandwidthMode === "profile" && !value.bandwidthProfileId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["bandwidthProfileId"], message: "Select a bandwidth profile." });
  }
};

export function bandwidthBpsFromInput(value: {
  downloadLimitMbps?: number | null; uploadLimitMbps?: number | null;
  burstDownloadMbps?: number | null; burstUploadMbps?: number | null;
}) {
  const convert = (amount?: number | null) => amount === undefined ? undefined : amount === null ? null : BigInt(Math.round(amount * 1_000_000));
  return {
    downloadLimitBps: convert(value.downloadLimitMbps), uploadLimitBps: convert(value.uploadLimitMbps),
    burstDownloadBps: convert(value.burstDownloadMbps), burstUploadBps: convert(value.burstUploadMbps),
  };
}

export const routerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  managementIp: z.string().trim().refine((value) => net.isIP(value) !== 0, "Enter a valid IPv4 or IPv6 management address."),
  apiPort: z.coerce.number().int().min(1).max(65535),
  apiType: z.enum(["native", "rest"]),
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(512),
  endpointHostname: optionalText.refine((value) => !value || /^[a-z\d.-]+$/i.test(value), "Enter a valid endpoint hostname."),
  endpointIp: optionalText.refine((value) => !value || net.isIP(value) !== 0, "Enter a valid endpoint IP."),
  wireguardPort: z.coerce.number().int().min(1).max(65535).optional(),
  useTls: z.boolean(),
  verifyTls: z.boolean(),
  enabled: z.boolean().default(true),
});

export const routerUpdateSchema = routerSchema.extend({ password: z.string().max(512).optional() });

export const peerCreateSchema = z.object({
  routerId: z.string().uuid(),
  interfaceId: z.string().uuid(),
  poolId: z.string().uuid(),
  assignmentMode: z.enum(["automatic","manual"]).default("automatic"),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  requestedIp: z.string().trim().optional(),
  allowedAddress: z.string().trim().optional(),
  clientAllowedIps: z.string().trim().min(3).max(500).default("0.0.0.0/0"),
  dnsServer: z.string().trim().min(1).max(255).default("1.1.1.1"),
  persistentKeepalive: z.coerce.number().int().min(0).max(65535).default(25),
  mtu: z.coerce.number().int().min(576).max(9000).default(1420),
  endpointOverride: z.string().trim().max(255).nullable().optional(),
  endpointPortOverride: z.coerce.number().int().min(1).max(65535).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional().transform((value) => value ? new Date(value) : null),
  usePresharedKey: z.boolean().default(false),
  profileId: z.string().uuid().nullable().optional(),
  ...bandwidthFields,
  ...quotaFields,
}).superRefine((value,context)=>{validateQuota(value,context);validateBandwidth(value,context);if(value.assignmentMode==="manual"&&!value.requestedIp)context.addIssue({code:z.ZodIssueCode.custom,path:["requestedIp"],message:"Enter a manual client IP address."})});

export const peerUpdateSchema = z.object({
  routerId: z.string().uuid(),
  interfaceId: z.string().uuid(),
  poolId: z.string().uuid(),
  clientIp: z.string().trim().refine((value) => net.isIPv4(value), "Enter a valid IPv4 client address."),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  allowedAddress: z.string().trim().min(3).max(500),
  clientAllowedIps: z.string().trim().min(3).max(500),
  dnsServer: z.string().trim().min(1).max(255),
  persistentKeepalive: z.coerce.number().int().min(0).max(65535),
  mtu: z.coerce.number().int().min(576).max(9000),
  expiresAt: z.string().datetime().nullable().optional().transform((value) => value ? new Date(value) : null),
  endpointOverride: z.string().trim().max(255).nullable().optional(),
  endpointPortOverride: z.coerce.number().int().min(1).max(65535).nullable().optional(),
  profileId: z.string().uuid().nullable().optional(),
  ...updateBandwidthFields,
  ...quotaFields,
}).superRefine((value,context)=>{validateQuota(value,context);validateBandwidth(value,context)});

export const interfaceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  listenPort: z.coerce.number().int().min(1).max(65535),
  mtu: z.coerce.number().int().min(576).max(9000),
  disabled: z.boolean(),
  clientPoolStart: z.string().trim().refine((value) => !value || net.isIPv4(value), "Enter a valid IPv4 pool start.").optional(),
  clientPoolEnd: z.string().trim().refine((value) => !value || net.isIPv4(value), "Enter a valid IPv4 pool end.").optional(),
  defaultDns: z.string().trim().min(1).max(255),
  defaultAllowedIps: z.string().trim().min(3).max(500),
}).refine((value) => Boolean(value.clientPoolStart) === Boolean(value.clientPoolEnd), { message: "Set both pool start and pool end, or leave both empty." });

export const poolSchema=z.object({
  name:z.string().trim().min(2).max(100),routerId:z.string().uuid(),interfaceId:z.string().uuid(),
  networkCidr:z.string().trim().min(9).max(32),gatewayIp:z.string().trim().refine(value=>net.isIPv4(value),"Enter the Router/WireGuard interface IPv4 address."),
  startIp:z.string().trim().refine(value=>net.isIPv4(value),"Enter a valid IPv4 start address."),
  endIp:z.string().trim().refine(value=>net.isIPv4(value),"Enter a valid IPv4 end address."),
  dns:z.string().trim().min(1).max(255),clientAllowedIps:z.string().trim().min(3).max(500),
  endpointHost:z.string().trim().max(255).nullable().optional(),endpointPort:z.coerce.number().int().min(1).max(65535).nullable().optional(),
  mtu:z.coerce.number().int().min(576).max(9000),persistentKeepalive:z.coerce.number().int().min(0).max(65535),enabled:z.boolean().default(true),
});

export const reservationSchema=z.object({ipAddress:z.string().trim().refine(value=>net.isIPv4(value),"Enter a valid IPv4 address."),comment:z.string().trim().min(2).max(200)});
