import { query } from "@/lib/db";
import { decryptSecret } from "@/lib/security";
import { createRouterClient } from "./routeros";

export type RouterRow = {
  id: string;
  name: string;
  management_ip: string;
  api_port: number;
  api_type: "native" | "rest";
  use_tls: boolean;
  verify_tls: boolean;
  username_encrypted: string;
  password_encrypted: string;
  endpoint_hostname: string | null;
  endpoint_ip: string | null;
  wireguard_port: number | null;
  enabled: boolean;
};

export async function getRouter(id: string) {
  const result = await query<RouterRow>("SELECT * FROM routers WHERE id = $1", [id]);
  const router = result.rows[0];
  if (!router) throw new Error("Router not found.");
  return router;
}

export function clientForRouter(router: RouterRow) {
  return createRouterClient({
    managementIp: router.management_ip,
    port: router.api_port,
    username: decryptSecret(router.username_encrypted),
    password: decryptSecret(router.password_encrypted),
    useTls: router.use_tls,
    verifyTls: router.verify_tls,
    apiType: router.api_type,
  });
}

export function routerEndpoint(router: Pick<RouterRow, "endpoint_hostname" | "endpoint_ip" | "management_ip">) {
  return router.endpoint_hostname?.trim() || router.endpoint_ip?.trim() || router.management_ip;
}
