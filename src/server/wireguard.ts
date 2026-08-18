import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";

export type WireGuardConfigInput = {
  privateKey: string;
  clientIp: string;
  dns: string;
  serverPublicKey: string;
  presharedKey?: string | null;
  allowedIps: string;
  endpointHost: string;
  endpointPort: number;
  persistentKeepalive: number;
  mtu?: number;
};

export function generateWireGuardKeys(includePresharedKey = false) {
  const pair = nacl.box.keyPair();
  return {
    privateKey: Buffer.from(pair.secretKey).toString("base64"),
    publicKey: Buffer.from(pair.publicKey).toString("base64"),
    presharedKey: includePresharedKey ? randomBytes(32).toString("base64") : null,
  };
}

export function generateClientConfig(input: WireGuardConfigInput) {
  const host = input.endpointHost.includes(":") && !input.endpointHost.startsWith("[")
    ? `[${input.endpointHost}]`
    : input.endpointHost;
  const lines = [
    "[Interface]",
    `PrivateKey = ${input.privateKey}`,
    `Address = ${input.clientIp.includes("/") ? input.clientIp : `${input.clientIp}/32`}`,
    `DNS = ${input.dns}`,
  ];
  if (input.mtu) lines.push(`MTU = ${input.mtu}`);
  lines.push(
    "",
    "[Peer]",
    `PublicKey = ${input.serverPublicKey}`,
  );
  if (input.presharedKey) lines.push(`PresharedKey = ${input.presharedKey}`);
  lines.push(
    `AllowedIPs = ${input.allowedIps}`,
    `Endpoint = ${host}:${input.endpointPort}`,
    `PersistentKeepalive = ${input.persistentKeepalive}`,
    "",
  );
  return lines.join("\n");
}
