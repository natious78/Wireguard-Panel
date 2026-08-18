import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { fail,handleApiError,ok } from "@/lib/api";
import { validateCsrf } from "@/lib/csrf";
import { getPeerQr,refreshPeerQr } from "@/server/qr-service";

function safeName(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "wireguard-peer"; }

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireUser("read");
  if (!auth.user) return fail(auth.error, auth.status);
  const { id } = await context.params;
  try {
    const url=new URL(request.url);const format=url.searchParams.get("format")==="svg"?"svg":"png";
    const qr=await getPeerQr(id,format);const download=url.searchParams.get("download")==="1";
    await audit({ user: auth.user, action: "qr_viewed", peerId: id, result: "success",details:{format} });
    return new Response(format==="png"?new Uint8Array(qr.body as Buffer):qr.body as string, {
      headers: {
        "Content-Type": qr.contentType, "Cache-Control": "private, no-store",
        ...(download ? { "Content-Disposition": `attachment; filename="${safeName(qr.name)}-wireguard.${format}"` } : {}),
      },
    });
  } catch (error) { return handleApiError(error); }
}

export async function POST(request:NextRequest,context:{params:Promise<{id:string}>}){
  const auth=await requireUser("write");if(!auth.user)return fail(auth.error,auth.status);
  if(!(await validateCsrf(request)))return fail("Security token expired.",403);const{id}=await context.params;
  try{await refreshPeerQr(id);await audit({user:auth.user,action:"qr_regenerated",peerId:id,result:"success"});return ok({id})}catch(error){return handleApiError(error)}
}
