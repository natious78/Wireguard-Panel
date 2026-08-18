import net from "node:net";
import { z } from "zod";

const optionalText = z.string().trim().max(255).optional().transform((value) => value || undefined);

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
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional(),
  requestedIp: z.string().trim().optional(),
  allowedAddress: z.string().trim().optional(),
  clientAllowedIps: z.string().trim().min(3).max(500).default("0.0.0.0/0"),
  dnsServer: z.string().trim().min(1).max(255).default("1.1.1.1"),
  persistentKeepalive: z.coerce.number().int().min(0).max(65535).default(25),
  mtu: z.coerce.number().int().min(576).max(9000).default(1420),
  expiresAt: z.string().datetime().nullable().optional().transform((value) => value ? new Date(value) : null),
  usePresharedKey: z.boolean().default(false),
});

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
