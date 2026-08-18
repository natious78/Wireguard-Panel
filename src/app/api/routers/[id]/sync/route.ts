import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, handleApiError, ok } from "@/lib/api";
import { syncRouter } from "@/server/sync";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser("write");
  if (!auth.user) return fail(auth.error, auth.status);
  if (!(await validateCsrf(request))) return fail("Security token expired.", 403);
  const { id } = await context.params;
  try {
    const summary = await syncRouter(id);
    await audit({ user: auth.user, action: "router_synchronized", routerId: id, result: summary.conflicts || summary.missing ? "warning" : "success", details: summary });
    return ok(summary);
  } catch (error) { return handleApiError(error); }
}
