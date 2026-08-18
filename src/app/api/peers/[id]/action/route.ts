import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, handleApiError, ok } from "@/lib/api";
import { deletePeer, ReconciliationConflictError, setPeerEnabled } from "@/server/peer-service";

const schema = z.object({ action: z.enum(["enable", "disable", "delete"]) });

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success) return fail("Unsupported peer action.", 422);
  const auth = await requireUser(input.data.action === "delete" ? "delete" : "write");
  if (!auth.user) return fail(auth.error, auth.status);
  if (!(await validateCsrf(request))) return fail("Security token expired.", 403);
  try {
    if (input.data.action === "delete") await deletePeer(id);
    else await setPeerEnabled(id, input.data.action === "enable");
    await audit({ user: auth.user, action: `peer_${input.data.action}d`, peerId: input.data.action === "delete" ? null : id, result: "success", details: input.data.action === "delete" ? { deletedPeerId: id } : undefined });
    return ok({ action: input.data.action });
  } catch (error) {
    if (error instanceof ReconciliationConflictError) return fail(error.message, 409, error.observed);
    return handleApiError(error);
  }
}
