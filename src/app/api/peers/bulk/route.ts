import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api";
import { deletePeer, setPeerEnabled } from "@/server/peer-service";
import { setPeerBandwidthPolicy } from "@/server/policy-service";

const schema=z.object({ids:z.array(z.string().uuid()).min(1).max(50),action:z.enum(["enable","disable","delete","bandwidth"]),confirmed:z.boolean().default(false),
  bandwidthMode:z.enum(["default","unlimited","custom","profile"]).optional(),bandwidthProfileId:z.string().uuid().nullable().optional(),
  downloadMbps:z.coerce.number().positive().nullable().optional(),uploadMbps:z.coerce.number().positive().nullable().optional()});

export async function POST(request:NextRequest){
  const input=schema.safeParse(await request.json().catch(()=>null));if(!input.success)return fail("Select between 1 and 50 peers and provide a valid action.",422);
  if(["delete","bandwidth"].includes(input.data.action)&&!input.data.confirmed)return fail("Confirm the planned bulk change before applying it.",422);
  const auth=await requireUser(input.data.action==="bandwidth"?"bandwidth:manage":"peer:bulk");if(!auth.user)return fail(auth.error,auth.status);
  if(!(await validateCsrf(request)))return fail("Security token expired.",403);const results=[];const bps=(value?:number|null)=>value?BigInt(Math.round(value*1e6)):null;
  for(const id of input.data.ids){try{
    if(input.data.action==="delete")await deletePeer(id,auth.user.id);
    else if(input.data.action==="bandwidth")await setPeerBandwidthPolicy(id,{mode:input.data.bandwidthMode??"default",profileId:input.data.bandwidthProfileId,downloadBps:bps(input.data.downloadMbps),uploadBps:bps(input.data.uploadMbps)},auth.user.id);
    else await setPeerEnabled(id,input.data.action==="enable");
    results.push({id,ok:true});await audit({user:auth.user,action:`peer_bulk_${input.data.action}`,peerId:input.data.action==="delete"?null:id,result:"success",details:input.data.action==="delete"?{deletedPeerId:id}:{bandwidthMode:input.data.bandwidthMode}});
  }catch(error){const message=error instanceof Error?error.message:"Action failed";results.push({id,ok:false,error:message});await audit({user:auth.user,action:`peer_bulk_${input.data.action}`,peerId:id,result:"failure",details:{error:message}})}}
  return ok({results,failed:results.filter(result=>!result.ok).length,succeeded:results.filter(result=>result.ok).length});
}
