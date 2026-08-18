import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fail, handleApiError } from "@/lib/api";
import { getPeerConfig } from "@/server/peer-service";

function safeName(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "wireguard-peer"; }

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser("read");
  if (!auth.user) return fail(auth.error, auth.status);
  const { id } = await context.params;
  try {
    const peer = await getPeerConfig(id);
    await audit({ user: auth.user, action: "configuration_downloaded", peerId: id, result: "success" });
    return new Response(peer.config, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeName(peer.name)}-wireguard.conf"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) { return handleApiError(error); }
}
