import net from "node:net";
import tls from "node:tls";
import { normalizeInterface, normalizePeer, rosBoolean, versionSupportsWireGuard } from "./normalize";
import type {
  CreateRemoteInterface,
  CreateRemotePeer,
  RemoteAddress,
  RemoteNatRule,
  RemoteRoute,
  RemoteWireGuardInterface,
  RemoteWireGuardPeer,
  RouterConnectionOptions,
  RouterFacts,
  RouterOsClient,
  UpdateRemoteInterface,
  UpdateRemotePeer,
} from "./types";
import { RouterConnectionError } from "./types";

type Socket = net.Socket | tls.TLSSocket;

export class NativeRouterOsClient implements RouterOsClient {
  constructor(private readonly options: RouterConnectionOptions) {}

  private async command(path: string, attributes: Record<string, string | number | boolean | undefined> = {}) {
    const socket = await connect(this.options);
    try {
      await exchange(socket, ["/login", `=name=${this.options.username}`, `=password=${this.options.password}`], this.options.timeoutMs);
      return await exchange(socket, [path, ...attributeWords(attributes)], this.options.timeoutMs);
    } finally {
      socket.destroy();
    }
  }

  async testConnection(): Promise<RouterFacts> {
    const [resourceRows, identityRows] = await Promise.all([
      this.command("/system/resource/print"),
      this.command("/system/identity/print"),
    ]);
    const resource = resourceRows[0] ?? {};
    const identity = identityRows[0] ?? {};
    const facts = {
      identity: identity.name ?? this.options.managementIp,
      version: resource.version ?? "unknown",
      architecture: resource["architecture-name"] ?? "unknown",
      boardName: resource["board-name"] ?? "unknown",
      uptime: resource.uptime ?? "unknown",
      wireguardSupported: versionSupportsWireGuard(resource.version ?? "0"),
    };
    if (!facts.wireguardSupported) throw new RouterConnectionError("unsupported", "WireGuard is not supported on this RouterOS version.");
    return facts;
  }

  async getInterfaces(): Promise<RemoteWireGuardInterface[]> { return (await this.command("/interface/wireguard/print")).map(normalizeInterface); }
  async getPeers(): Promise<RemoteWireGuardPeer[]> { const observedAt=new Date();return (await this.command("/interface/wireguard/peers/print")).map(row=>normalizePeer(row,observedAt)); }
  async getAddresses(): Promise<RemoteAddress[]> {
    return (await this.command("/ip/address/print")).map((row) => ({
      id: row[".id"] ?? "", interfaceName: row.interface ?? "", address: row.address ?? "", disabled: rosBoolean(row.disabled),
    }));
  }
  getRoutes(): Promise<RemoteRoute[]> { return this.command("/ip/route/print"); }
  getNatRules(): Promise<RemoteNatRule[]> { return this.command("/ip/firewall/nat/print"); }

  async createPeer(peer: CreateRemotePeer) {
    const result = await this.command("/interface/wireguard/peers/add", toNativePeer(peer));
    return result[0]?.ret ?? result[0]?.[".id"] ?? "";
  }
  async updatePeer(id: string, peer: UpdateRemotePeer) {
    await this.command("/interface/wireguard/peers/set", { ".id": id, ...toNativePeer(peer) });
  }
  async deletePeer(id: string) { await this.command("/interface/wireguard/peers/remove", { ".id": id }); }
  async createInterface(input: CreateRemoteInterface) {
    const result = await this.command("/interface/wireguard/add", toNativeInterface(input));
    return result[0]?.ret ?? result[0]?.[".id"] ?? "";
  }
  async updateInterface(id: string, input: UpdateRemoteInterface) {
    await this.command("/interface/wireguard/set", { ".id": id, ...toNativeInterface(input) });
  }
  async close() {}
}

async function connect(options: RouterConnectionOptions): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      const message = error.message;
      const tlsError = /certificate|tls|ssl|self[- ]signed/i.test(message);
      reject(new RouterConnectionError(tlsError ? "tls_error" : "api_unavailable", tlsError ? "RouterOS API TLS validation failed." : "RouterOS native API is unavailable.", { cause: error }));
    };
    const socket = options.useTls
      ? tls.connect({ host: options.managementIp, port: options.port, rejectUnauthorized: options.verifyTls, servername: net.isIP(options.managementIp) ? undefined : options.managementIp }, () => {
          clearTimeout(timeout); socket.off("error", onError); resolve(socket);
        })
      : net.connect({ host: options.managementIp, port: options.port }, () => {
          clearTimeout(timeout); socket.off("error", onError); resolve(socket);
        });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new RouterConnectionError("timeout", `Connection to ${options.managementIp}:${options.port} timed out.`));
    }, options.timeoutMs);
    socket.once("error", onError);
  });
}

async function exchange(socket: Socket, words: string[], timeoutMs: number): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const records: Record<string, string>[] = [];
    const timer = setTimeout(() => finish(new RouterConnectionError("timeout", "RouterOS API command timed out.")), timeoutMs);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error) reject(error); else resolve(records);
    };
    const onError = (error: Error) => finish(new RouterConnectionError("api_unavailable", "RouterOS API connection was interrupted.", { cause: error }));
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const decoded = decodeSentence(buffer);
        if (!decoded) break;
        buffer = buffer.subarray(decoded.bytes);
        const [kind, ...attributes] = decoded.words;
        const row = parseAttributes(attributes);
        if (kind === "!re") records.push(row);
        if (kind === "!trap" || kind === "!fatal") {
          const message = row.message || "RouterOS rejected the command.";
          finish(new RouterConnectionError(/invalid user|not logged in/i.test(message) ? "auth_failed" : "router_error", message));
          return;
        }
        if (kind === "!done") {
          if (Object.keys(row).length) records.push(row);
          finish();
          return;
        }
      }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.write(encodeSentence(words));
  });
}

function attributeWords(attributes: Record<string, string | number | boolean | undefined>) {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `=${key}=${typeof value === "boolean" ? (value ? "yes" : "no") : value}`);
}

function encodeSentence(words: string[]) { return Buffer.concat([...words.map(encodeWord), Buffer.from([0])]); }
function encodeWord(word: string) {
  const body = Buffer.from(word);
  return Buffer.concat([encodeLength(body.length), body]);
}
function encodeLength(length: number) {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x4000) return Buffer.from([(length >> 8) | 0x80, length & 0xff]);
  if (length < 0x20_0000) return Buffer.from([(length >> 16) | 0xc0, (length >> 8) & 0xff, length & 0xff]);
  if (length < 0x1000_0000) return Buffer.from([(length >> 24) | 0xe0, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
  const output = Buffer.alloc(5); output[0] = 0xf0; output.writeUInt32BE(length, 1); return output;
}
function decodeLength(buffer: Buffer, offset: number): { length: number; bytes: number } | null {
  if (offset >= buffer.length) return null;
  const first = buffer[offset];
  if ((first & 0x80) === 0) return { length: first, bytes: 1 };
  if ((first & 0xc0) === 0x80) {
    if (offset + 2 > buffer.length) return null;
    return { length: ((first & 0x3f) << 8) + buffer[offset + 1], bytes: 2 };
  }
  if ((first & 0xe0) === 0xc0) {
    if (offset + 3 > buffer.length) return null;
    return { length: ((first & 0x1f) << 16) + (buffer[offset + 1] << 8) + buffer[offset + 2], bytes: 3 };
  }
  if ((first & 0xf0) === 0xe0) {
    if (offset + 4 > buffer.length) return null;
    return { length: ((first & 0x0f) * 0x1000000) + (buffer[offset + 1] << 16) + (buffer[offset + 2] << 8) + buffer[offset + 3], bytes: 4 };
  }
  if (first === 0xf0) {
    if (offset + 5 > buffer.length) return null;
    return { length: buffer.readUInt32BE(offset + 1), bytes: 5 };
  }
  throw new Error("Unsupported RouterOS API word length.");
}
function decodeSentence(buffer: Buffer): { words: string[]; bytes: number } | null {
  let offset = 0; const words: string[] = [];
  while (true) {
    const prefix = decodeLength(buffer, offset); if (!prefix) return null;
    offset += prefix.bytes;
    if (prefix.length === 0) return { words, bytes: offset };
    if (offset + prefix.length > buffer.length) return null;
    words.push(buffer.subarray(offset, offset + prefix.length).toString()); offset += prefix.length;
  }
}
function parseAttributes(words: string[]) {
  const output: Record<string, string> = {};
  for (const word of words) {
    const normalized = word.startsWith("=") ? word.slice(1) : word;
    const index = normalized.indexOf("=");
    if (index === -1) output[normalized] = "";
    else output[normalized.slice(0, index)] = normalized.slice(index + 1);
  }
  return output;
}
function toNativePeer(peer: CreateRemotePeer | UpdateRemotePeer) {
  return {
    interface: "interfaceName" in peer ? peer.interfaceName : undefined,
    "public-key": "publicKey" in peer ? peer.publicKey : undefined,
    "allowed-address": peer.allowedAddress,
    comment: peer.comment,
    "persistent-keepalive": peer.persistentKeepalive,
    "preshared-key": peer.presharedKey,
    "endpoint-address": "endpointAddress" in peer ? (peer.endpointAddress === null ? "" : peer.endpointAddress) : undefined,
    "endpoint-port": "endpointPort" in peer ? (peer.endpointPort === null ? 0 : peer.endpointPort) : undefined,
    disabled: peer.disabled,
  };
}
function toNativeInterface(input: CreateRemoteInterface | UpdateRemoteInterface) {
  return { name: input.name, "listen-port": input.listenPort, mtu: input.mtu, disabled: input.disabled };
}
