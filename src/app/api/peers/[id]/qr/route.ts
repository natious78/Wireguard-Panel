import QRCode from "qrcode";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fail, handleApiError } from "@/lib/api";
import { getPeerConfig } from "@/server/peer-service";

function safeName(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "wireguard-peer"; }

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser("read");
  if (!auth.user) return fail(auth.error, auth.status);
  const { id } = await context.params;
  try {
    const peer = await getPeerConfig(id);
    const png = await QRCode.toBuffer(peer.config, { type: "png", width: 768, margin: 3, errorCorrectionLevel: "M", color: { dark: "#07111f", light: "#ffffff" } });
    const download = new URL(request.url).searchParams.get("download") === "1";
    await audit({ user: auth.user, action: "qr_generated", peerId: id, result: "success" });
    return new Response(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png", "Cache-Control": "no-store",
        ...(download ? { "Content-Disposition": `attachment; filename="${safeName(peer.name)}-wireguard.png"` } : {}),
      },
    });
  } catch (error) { return handleApiError(error); }
}
