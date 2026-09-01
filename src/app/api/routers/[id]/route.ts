import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, handleApiError, ok } from "@/lib/api";
import { query } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/security";
import { routerUpdateSchema } from "@/lib/validation";
import { createRouterClient } from "@/server/routeros";
import type { RouterRow } from "@/server/router-repository";
import { syncRouter } from "@/server/sync";

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser("write"); if (!auth.user) return fail(auth.error, auth.status);
  if (!(await validateCsrf(request))) return fail("Security token expired.", 403);
  const { id } = await context.params;
  try {
    const input = routerUpdateSchema.parse(await request.json());
    const existing = (await query<RouterRow>("SELECT * FROM routers WHERE id=$1", [id])).rows[0];
    if (!existing) return fail("Router not found.", 404);
    let password=input.password;
    if(!password){
      try{password=decryptSecret(existing.password_encrypted)}
      catch{return fail("The stored router password cannot be decrypted. Enter the MikroTik API password to recover this router with the current encryption key.",400)}
    }
    const client = createRouterClient({ managementIp: input.managementIp,port:input.apiPort,username:input.username,password,
      apiType:input.apiType,useTls:input.useTls,verifyTls:input.verifyTls });
    let facts; try { facts = await client.testConnection(); } finally { await client.close(); }
    await query(
      `UPDATE routers SET name=$2,management_ip=$3,api_port=$4,api_type=$5,use_tls=$6,verify_tls=$7,
       username_encrypted=$8,password_encrypted=$9,endpoint_hostname=$10,endpoint_ip=$11,wireguard_port=$12,
       enabled=$13,connection_status='connected',identity=$14,routeros_version=$15,architecture=$16,board_name=$17,
       uptime=$18,wireguard_supported=$19,last_checked_at=now(),last_error=NULL,updated_at=now() WHERE id=$1`,
      [id,input.name,input.managementIp,input.apiPort,input.apiType,input.useTls,input.verifyTls,encryptSecret(input.username),
       input.password ? encryptSecret(input.password) : existing.password_encrypted,input.endpointHostname||null,input.endpointIp||null,
       input.wireguardPort||null,input.enabled,facts.identity,facts.version,facts.architecture,facts.boardName,facts.uptime,facts.wireguardSupported],
    );
    await syncRouter(id);
    await audit({ user:auth.user,action:"router_edited",routerId:id,result:"success",details:{ name:input.name } });
    return ok({ id });
  } catch (error) { return handleApiError(error); }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser("delete"); if (!auth.user) return fail(auth.error, auth.status);
  if (!(await validateCsrf(request))) return fail("Security token expired.",403);
  const { id } = await context.params;
  try {
    const router = (await query<{ name:string }>("SELECT name FROM routers WHERE id=$1",[id])).rows[0];
    if (!router) return fail("Router not found.",404);
    await query("DELETE FROM routers WHERE id=$1",[id]);
    await audit({ user:auth.user,action:"router_deleted",result:"success",details:{ name:router.name } });
    return ok({ deleted:true });
  } catch (error) { return handleApiError(error); }
}
