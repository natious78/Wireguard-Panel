import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, handleApiError, ok } from "@/lib/api";
import { peerCreateSchema, quotaBytesFromInput } from "@/lib/validation";
import { createPeer } from "@/server/peer-service";

export async function POST(request: NextRequest) {
  const auth = await requireUser("write");
  if (!auth.user) return fail(auth.error, auth.status);
  if (!(await validateCsrf(request))) return fail("Security token expired.", 403);
  try {
    const input = peerCreateSchema.parse(await request.json());
    const quotaBytes = quotaBytesFromInput(input);
    const peer = await createPeer({ ...input, quotaBytes, quotaPeriod: quotaBytes ? input.quotaPeriod : null, userId: auth.user.id });
    await audit({ user: auth.user, action: "peer_created", routerId: input.routerId, peerId: peer.id, result: "success", details: { name: input.name, clientIp: peer.clientIp, quotaBytes: quotaBytes?.toString() ?? null, quotaPeriod: quotaBytes ? input.quotaPeriod : null } });
    return ok(peer, { status: 201 });
  } catch (error) { return handleApiError(error); }
}
