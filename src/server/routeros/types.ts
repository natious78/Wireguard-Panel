export type RouterApiType = "native" | "rest";

export type RouterConnectionOptions = {
  managementIp: string;
  port: number;
  username: string;
  password: string;
  useTls: boolean;
  verifyTls: boolean;
  apiType: RouterApiType;
  timeoutMs: number;
};

export type RouterFacts = {
  identity: string;
  version: string;
  architecture: string;
  boardName: string;
  uptime: string;
  wireguardSupported: boolean;
};

export type RouterClock = { date: string; time: string; timeZoneName: string | null };

export type RemoteWireGuardInterface = {
  id: string;
  name: string;
  listenPort: number;
  mtu: number;
  publicKey: string;
  running: boolean;
  disabled: boolean;
};

export type RemoteWireGuardPeer = {
  id: string;
  interfaceName: string;
  name: string;
  comment: string;
  publicKey: string;
  allowedAddress: string;
  endpointAddress: string | null;
  endpointPort: number | null;
  persistentKeepalive: number;
  disabled: boolean;
  lastHandshakeAt: Date | null;
  lastHandshakeRaw: string | null;
  lastHandshakeParseValid: boolean;
  rxBytes: bigint;
  txBytes: bigint;
};

export type RemoteAddress = { id: string; interfaceName: string; address: string; disabled: boolean };
export type RemoteRoute = Record<string, string>;
export type RemoteNatRule = Record<string, string>;
export type RemoteQueueTree = Record<string, string>;
export type RemoteMangleRule = Record<string, string>;
export type RemoteFilterRule = Record<string, string>;

export type RemoteSimpleQueue = {
  id:string;
  name:string;
  target:string;
  maxLimit:string;
  burstLimit:string;
  burstThreshold:string;
  burstTime:string;
  disabled:boolean;
  comment:string;
  dynamic:boolean;
  invalid:boolean;
};

export type CreateRemoteSimpleQueue = {
  name:string;
  target:string;
  maxLimit:string;
  comment:string;
  disabled?:boolean;
  burstLimit?:string;
  burstThreshold?:string;
  burstTime?:string;
};
export type UpdateRemoteSimpleQueue = Partial<CreateRemoteSimpleQueue>;

export type CreateRemotePeer = {
  interfaceName: string;
  publicKey: string;
  allowedAddress: string;
  comment: string;
  persistentKeepalive: number;
  presharedKey?: string;
  disabled?: boolean;
};

export type UpdateRemotePeer = Partial<CreateRemotePeer> & {
  endpointAddress?: string | null;
  endpointPort?: number | null;
};

export type CreateRemoteInterface = { name: string; listenPort: number; mtu: number; disabled?: boolean };
export type UpdateRemoteInterface = Partial<CreateRemoteInterface>;

export interface RouterOsClient {
  testConnection(): Promise<RouterFacts>;
  getClock(): Promise<RouterClock>;
  getInterfaces(): Promise<RemoteWireGuardInterface[]>;
  getPeers(): Promise<RemoteWireGuardPeer[]>;
  getAddresses(): Promise<RemoteAddress[]>;
  getRoutes(): Promise<RemoteRoute[]>;
  getNatRules(): Promise<RemoteNatRule[]>;
  getSimpleQueues(): Promise<RemoteSimpleQueue[]>;
  getQueueTrees(): Promise<RemoteQueueTree[]>;
  getMangleRules(): Promise<RemoteMangleRule[]>;
  getFilterRules(): Promise<RemoteFilterRule[]>;
  createPeer(peer: CreateRemotePeer): Promise<string>;
  updatePeer(id: string, peer: UpdateRemotePeer): Promise<void>;
  deletePeer(id: string): Promise<void>;
  createInterface(input: CreateRemoteInterface): Promise<string>;
  updateInterface(id: string, input: UpdateRemoteInterface): Promise<void>;
  createSimpleQueue(input: CreateRemoteSimpleQueue): Promise<string>;
  updateSimpleQueue(id: string, input: UpdateRemoteSimpleQueue): Promise<void>;
  deleteSimpleQueue(id: string): Promise<void>;
  close(): Promise<void>;
}

export type RouterErrorCode =
  | "auth_failed"
  | "timeout"
  | "api_unavailable"
  | "tls_error"
  | "unsupported"
  | "router_error";

export class RouterConnectionError extends Error {
  constructor(
    public readonly code: RouterErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RouterConnectionError";
  }
}
