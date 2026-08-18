import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { fail, handleApiError, ok } from "@/lib/api";
import { audit } from "@/lib/audit";
import { createRouterClient, RouterConnectionError } from "@/server/routeros";
import { routerSchema } from "@/lib/validation";

export async function POST(request: NextRequest) {
  const auth = await requireUser("write");
  if (!auth.user) return fail(auth.error, auth.status);
  if (!(await validateCsrf(request))) return fail("Security token expired. Refresh and try again.", 403);
  try {
    const input = routerSchema.parse(await request.json());
    const client = createRouterClient({
      managementIp: input.managementIp, port: input.apiPort, username: input.username, password: input.password,
      apiType: input.apiType, useTls: input.useTls, verifyTls: input.verifyTls,
    });
    try {
      const facts = await client.testConnection();
      const interfaces = await client.getInterfaces();
      await audit({ user: auth.user, action: "router_connection_tested", result: "success", details: { managementIp: input.managementIp, identity: facts.identity } });
      return ok({ status: "connected", facts, interfaces: interfaces.map(({ id, name, listenPort, mtu, running }) => ({ id, name, listenPort, mtu, running })) });
    } finally { await client.close(); }
  } catch (error) {
    if (error instanceof RouterConnectionError) {
      await audit({ user: auth.user, action: "router_connection_tested", result: "failure", details: { code: error.code } });
      return fail(error.message, error.code === "auth_failed" ? 401 : 422, { code: error.code });
    }
    return handleApiError(error);
  }
}
