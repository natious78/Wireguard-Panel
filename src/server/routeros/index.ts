import { env } from "@/lib/env";
import { NativeRouterOsClient } from "./native-client";
import { RestRouterOsClient } from "./rest-client";
import { MockRouterOsClient } from "./mock-client";
import type { RouterConnectionOptions } from "./types";

export * from "./types";
export * from "./normalize";

export function createRouterClient(options: Omit<RouterConnectionOptions, "timeoutMs"> & { timeoutMs?: number }) {
  if (env().DEMO_MODE) return new MockRouterOsClient();
  const complete: RouterConnectionOptions = { ...options, timeoutMs: options.timeoutMs ?? env().ROUTER_CONNECT_TIMEOUT_MS };
  return complete.apiType === "rest" ? new RestRouterOsClient(complete) : new NativeRouterOsClient(complete);
}
