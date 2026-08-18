import { headers } from "next/headers";
import type { SessionUser } from "./auth";
import { clientIp } from "./auth";
import { query } from "./db";

export async function audit(input: {
  user?: SessionUser | null;
  action: string;
  routerId?: string | null;
  peerId?: string | null;
  result: "success" | "failure" | "warning";
  details?: Record<string, unknown>;
}) {
  const requestHeaders = await headers();
  await query(
    `INSERT INTO audit_logs(user_id, username, action, router_id, peer_id, result, details, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.user?.id ?? null,
      input.user?.username ?? "system",
      input.action,
      input.routerId ?? null,
      input.peerId ?? null,
      input.result,
      JSON.stringify(input.details ?? {}),
      clientIp(requestHeaders),
    ],
  );
}
