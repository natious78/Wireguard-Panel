import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, handleApiError, ok } from "@/lib/api";
import { deletePeer, ReconciliationConflictError, resetPeerQuotaUsage, setPeerEnabled, temporarilyReenablePeer } from "@/server/peer-service";

const schema = z.object({ action: z.enum(["enable", "disable", "delete", "reset_usage", "temporary_reenable"]), minutes: z.coerce.number().int().min(5).max(1440).default(60) });

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success) return fail("Unsupported peer action.", 422);
  const auth = await requireUser(input.data.action === "delete" ? "peer:delete" : input.data.action === "reset_usage" || input.data.action === "temporary_reenable" ? "traffic:reset" : "peer:disable");
  if (!auth.user) return fail(auth.error, auth.status);
  if (!(await validateCsrf(request))) return fail("Security token expired.", 403);
  try {
    let details: Record<string, unknown> | undefined;
    if (input.data.action === "delete") { await deletePeer(id,auth.user.id); details = { deletedPeerId: id }; }
    else if (input.data.action === "reset_usage") details = await resetPeerQuotaUsage(id);
    else if (input.data.action === "temporary_reenable") details = await temporarilyReenablePeer(id, input.data.minutes);
    else await setPeerEnabled(id, input.data.action === "enable");
    const auditAction = { enable:"peer_enabled", disable:"peer_disabled", delete:"peer_deleted", reset_usage:"peer_quota_usage_reset", temporary_reenable:"peer_quota_temporarily_reenabled" }[input.data.action];
    await audit({ user: auth.user, action: auditAction, peerId: input.data.action === "delete" ? null : id, result: "success", details });
    return ok({ action: input.data.action, ...details });
  } catch (error) {
    if (error instanceof ReconciliationConflictError) return fail(error.message, 409, error.observed);
    return handleApiError(error);
  }
}
