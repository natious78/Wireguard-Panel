import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fail, handleApiError } from "@/lib/api";
import { getPeerConfig } from "@/server/peer-service";

function safeName(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "wireguard-peer"; }

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const download=new URL(request.url).searchParams.get("download")!=="0";
  const auth = await requireUser(download?"peer:download_config":"peer:view_config");
  if (!auth.user) return fail(auth.error, auth.status);
  const { id } = await context.params;
  try {
    const peer = await getPeerConfig(id);
    await audit({ user: auth.user, action: download?"protected_configuration_downloaded":"protected_configuration_viewed", peerId: id, result: "success" });
    return new Response(peer.config, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `${download?"attachment":"inline"}; filename="${safeName(peer.name)}-wireguard.conf"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) { return handleApiError(error); }
}
