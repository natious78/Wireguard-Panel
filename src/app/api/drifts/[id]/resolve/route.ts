import { NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { fail, handleApiError, ok } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { DriftChangedError, resolveConfigurationDrift } from "@/server/drift-service";

const schema = z.object({ resolution: z.enum(["keep_router", "apply_application"]) });

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser("drift:resolve");
  if (!auth.user) return fail(auth.error, auth.status);
  if (!(await validateCsrf(request))) return fail("Security token expired.", 403);
  const { id } = await context.params;
  try {
    const input = schema.parse(await request.json());
    await resolveConfigurationDrift(id, input.resolution, auth.user.id);
    await audit({ user: auth.user, action: "configuration_drift_resolved", result: "success", details: { driftId: id, resolution: input.resolution } });
    return ok({ id, resolution: input.resolution });
  } catch (error) {
    if (error instanceof DriftChangedError) return fail(error.message, 409, error.current);
    return handleApiError(error);
  }
}
