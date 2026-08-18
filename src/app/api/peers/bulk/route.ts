import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api";
import { deletePeer, setPeerEnabled } from "@/server/peer-service";
const schema=z.object({ids:z.array(z.string().uuid()).min(1).max(50),action:z.enum(["enable","disable","delete"])});
export async function POST(request:NextRequest){const input=schema.safeParse(await request.json().catch(()=>null));if(!input.success)return fail("Select between 1 and 50 peers.",422);const auth=await requireUser(input.data.action==="delete"?"delete":"write");if(!auth.user)return fail(auth.error,auth.status);if(!(await validateCsrf(request)))return fail("Security token expired.",403);const results=[];for(const id of input.data.ids){try{if(input.data.action==="delete")await deletePeer(id);else await setPeerEnabled(id,input.data.action==="enable");results.push({id,ok:true});await audit({user:auth.user,action:`peer_bulk_${input.data.action}`,peerId:input.data.action==="delete"?null:id,result:"success",details:input.data.action==="delete"?{deletedPeerId:id}:undefined})}catch(error){results.push({id,ok:false,error:error instanceof Error?error.message:"Action failed"});await audit({user:auth.user,action:`peer_bulk_${input.data.action}`,peerId:id,result:"failure",details:{error:error instanceof Error?error.message:"Action failed"}})}}return ok({results,failed:results.filter(r=>!r.ok).length})}
