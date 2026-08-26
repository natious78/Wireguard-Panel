import { normalizeInterface, normalizePeer, rosBoolean, versionSupportsWireGuard } from "./normalize";
import type {
  CreateRemoteInterface,
  CreateRemotePeer,
  CreateRemoteSimpleQueue,
  RemoteAddress,
  RemoteNatRule,
  RemoteMangleRule,
  RemoteFilterRule,
  RemoteQueueTree,
  RemoteSimpleQueue,
  RemoteRoute,
  RemoteWireGuardInterface,
  RemoteWireGuardPeer,
  RouterConnectionOptions,
  RouterFacts,
  RouterClock,
  RouterOsClient,
  UpdateRemoteInterface,
  UpdateRemotePeer,
  UpdateRemoteSimpleQueue,
} from "./types";
import { RouterConnectionError } from "./types";
import { Agent } from "undici";

export class RestRouterOsClient implements RouterOsClient {
  private readonly dispatcher: Agent | undefined;
  constructor(private readonly options: RouterConnectionOptions) {
    this.dispatcher = options.useTls && !options.verifyTls ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const protocol = this.options.useTls ? "https" : "http";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(`${protocol}://${this.options.managementIp}:${this.options.port}/rest/${path}`, {
        ...init,
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.options.username}:${this.options.password}`).toString("base64")}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      } as RequestInit & { dispatcher?: Agent });
      if (response.status === 401 || response.status === 403) {
        throw new RouterConnectionError("auth_failed", "RouterOS rejected the API username or password.");
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new RouterConnectionError("router_error", body.message || `RouterOS REST request failed with HTTP ${response.status}.`);
      }
      if (response.status === 204 || response.headers.get("content-length") === "0") return undefined as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (error) {
      if (error instanceof RouterConnectionError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new RouterConnectionError("timeout", `Connection to ${this.options.managementIp} timed out.`, { cause: error });
      }
      const message = error instanceof Error ? error.message : "REST connection failed";
      const tls = /certificate|tls|ssl|self[- ]signed/i.test(message);
      throw new RouterConnectionError(tls ? "tls_error" : "api_unavailable", tls ? "TLS certificate validation failed." : "RouterOS REST API is unavailable.", { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  async testConnection(): Promise<RouterFacts> {
    const [resourceRows, identityRows] = await Promise.all([
      this.request<Record<string, string>[]>("system/resource"),
      this.request<Record<string, string>[]>("system/identity"),
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

  async getClock(): Promise<RouterClock> {
    const row=(await this.request<Record<string,string>[]>("system/clock"))[0]??{};
    return {date:row.date??"",time:row.time??"",timeZoneName:row["time-zone-name"]??null};
  }

  async getInterfaces(): Promise<RemoteWireGuardInterface[]> {
    return (await this.request<Record<string, unknown>[]>("interface/wireguard")).map(normalizeInterface);
  }
  async getPeers(): Promise<RemoteWireGuardPeer[]> {
    const observedAt=new Date();
    return (await this.request<Record<string, unknown>[]>("interface/wireguard/peers")).map(row=>normalizePeer(row,observedAt));
  }
  async getAddresses(): Promise<RemoteAddress[]> {
    return (await this.request<Record<string, unknown>[]>("ip/address")).map((row) => ({
      id: String(row[".id"] ?? ""), interfaceName: String(row.interface ?? ""), address: String(row.address ?? ""), disabled: rosBoolean(row.disabled),
    }));
  }
  getRoutes() { return this.request<RemoteRoute[]>("ip/route"); }
  getNatRules() { return this.request<RemoteNatRule[]>("ip/firewall/nat"); }
  async getSimpleQueues():Promise<RemoteSimpleQueue[]>{return(await this.request<Record<string,unknown>[]>("queue/simple")).map(normalizeSimpleQueue)}
  getQueueTrees(){return this.request<RemoteQueueTree[]>("queue/tree")}
  getMangleRules(){return this.request<RemoteMangleRule[]>("ip/firewall/mangle")}
  getFilterRules(){return this.request<RemoteFilterRule[]>("ip/firewall/filter")}

  async createPeer(peer: CreateRemotePeer) {
    const result = await this.request<Record<string, string>>("interface/wireguard/peers", {
      method: "PUT",
      body: JSON.stringify(toRosPeer(peer)),
    });
    return result[".id"];
  }
  async updatePeer(id: string, peer: UpdateRemotePeer) {
    await this.request(`interface/wireguard/peers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(toRosPeer(peer)) });
  }
  async deletePeer(id: string) {
    await this.request(`interface/wireguard/peers/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
  async createInterface(input: CreateRemoteInterface) {
    const result = await this.request<Record<string, string>>("interface/wireguard", {
      method: "PUT", body: JSON.stringify(toRosInterface(input)),
    });
    return result[".id"];
  }
  async updateInterface(id: string, input: UpdateRemoteInterface) {
    await this.request(`interface/wireguard/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(toRosInterface(input)) });
  }
  async createSimpleQueue(input:CreateRemoteSimpleQueue){const result=await this.request<Record<string,string>>("queue/simple",{method:"PUT",body:JSON.stringify(toRosSimpleQueue(input))});return result[".id"]}
  async updateSimpleQueue(id:string,input:UpdateRemoteSimpleQueue){await this.request(`queue/simple/${encodeURIComponent(id)}`,{method:"PATCH",body:JSON.stringify(toRosSimpleQueue(input))})}
  async deleteSimpleQueue(id:string){await this.request(`queue/simple/${encodeURIComponent(id)}`,{method:"DELETE"})}
  async close() { if (this.dispatcher) await this.dispatcher.close(); }
}

function toRosPeer(peer: CreateRemotePeer | UpdateRemotePeer) {
  return Object.fromEntries(Object.entries({
    interface: "interfaceName" in peer ? peer.interfaceName : undefined,
    "public-key": "publicKey" in peer ? peer.publicKey : undefined,
    "allowed-address": peer.allowedAddress,
    comment: peer.comment,
    "persistent-keepalive": peer.persistentKeepalive?.toString(),
    "preshared-key": peer.presharedKey,
    "endpoint-address": "endpointAddress" in peer ? (peer.endpointAddress === null ? "" : peer.endpointAddress) : undefined,
    "endpoint-port": "endpointPort" in peer ? (peer.endpointPort === null ? "0" : peer.endpointPort?.toString()) : undefined,
    disabled: peer.disabled === undefined ? undefined : peer.disabled ? "yes" : "no",
  }).filter(([, value]) => value !== undefined));
}

function toRosInterface(input: CreateRemoteInterface | UpdateRemoteInterface) {
  return Object.fromEntries(Object.entries({
    name: input.name,
    "listen-port": input.listenPort?.toString(),
    mtu: input.mtu?.toString(),
    disabled: input.disabled === undefined ? undefined : input.disabled ? "yes" : "no",
  }).filter(([, value]) => value !== undefined));
}
function toRosSimpleQueue(input:CreateRemoteSimpleQueue|UpdateRemoteSimpleQueue){return Object.fromEntries(Object.entries({name:input.name,target:input.target,"max-limit":input.maxLimit,comment:input.comment,disabled:input.disabled===undefined?undefined:input.disabled?"yes":"no","burst-limit":input.burstLimit,"burst-threshold":input.burstThreshold,"burst-time":input.burstTime}).filter(([,value])=>value!==undefined))}
function normalizeSimpleQueue(row:Record<string,unknown>):RemoteSimpleQueue{return{id:String(row[".id"]??""),name:String(row.name??""),target:String(row.target??row["target-addresses"]??""),maxLimit:String(row["max-limit"]??"0/0"),burstLimit:String(row["burst-limit"]??"0/0"),burstThreshold:String(row["burst-threshold"]??"0/0"),burstTime:String(row["burst-time"]??"0s/0s"),disabled:rosBoolean(row.disabled),comment:String(row.comment??""),dynamic:rosBoolean(row.dynamic),invalid:rosBoolean(row.invalid)}}
