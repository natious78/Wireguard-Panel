import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { fail, handleApiError, ok } from "@/lib/api";
import { query } from "@/lib/db";
import { encryptSecret } from "@/lib/security";
import { routerSchema } from "@/lib/validation";
import { createRouterClient } from "@/server/routeros";
import { syncRouter } from "@/server/sync";
import { audit } from "@/lib/audit";

export async function POST(request: NextRequest) {
  const auth = await requireUser("write");
  if (!auth.user) return fail(auth.error, auth.status);
  if (!(await validateCsrf(request))) return fail("Security token expired. Refresh and try again.", 403);
  try {
    const input = routerSchema.parse(await request.json());
    const client = createRouterClient({ managementIp: input.managementIp, port: input.apiPort, username: input.username,
      password: input.password, apiType: input.apiType, useTls: input.useTls, verifyTls: input.verifyTls });
    let facts;
    try { facts = await client.testConnection(); } finally { await client.close(); }
    const result = await query<{ id: string }>(
      `INSERT INTO routers(name,management_ip,api_port,api_type,use_tls,verify_tls,username_encrypted,password_encrypted,
       endpoint_hostname,endpoint_ip,wireguard_port,enabled,connection_status,identity,routeros_version,architecture,board_name,uptime,wireguard_supported,last_checked_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'connected',$13,$14,$15,$16,$17,$18,now()) RETURNING id`,
      [input.name,input.managementIp,input.apiPort,input.apiType,input.useTls,input.verifyTls,encryptSecret(input.username),encryptSecret(input.password),
        input.endpointHostname ?? null,input.endpointIp ?? null,input.wireguardPort ?? null,input.enabled,facts.identity,facts.version,facts.architecture,facts.boardName,facts.uptime,facts.wireguardSupported],
    );
    await syncRouter(result.rows[0].id);
    await audit({ user: auth.user, action: "router_added", routerId: result.rows[0].id, result: "success", details: { name: input.name, managementIp: input.managementIp } });
    return ok({ id: result.rows[0].id }, { status: 201 });
  } catch (error) { return handleApiError(error); }
}
