import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, handleApiError, ok } from "@/lib/api";
import { ReconciliationConflictError, updatePeer } from "@/server/peer-service";
import { bandwidthBpsFromInput, peerUpdateSchema, quotaBytesFromInput } from "@/lib/validation";

export async function PUT(request:NextRequest,context:{params:Promise<{id:string}>}){const auth=await requireUser("peer:update");if(!auth.user)return fail(auth.error,auth.status);if(!(await validateCsrf(request)))return fail("Security token expired.",403);const {id}=await context.params;try{const input=peerUpdateSchema.parse(await request.json());const quotaBytes=quotaBytesFromInput(input);const bandwidth=bandwidthBpsFromInput(input);await updatePeer(id,{...input,...bandwidth,quotaBytes,quotaPeriod:quotaBytes?input.quotaPeriod:null,userId:auth.user.id});await audit({user:auth.user,action:"peer_edited",peerId:id,result:"success",details:{name:input.name,poolId:input.poolId,clientIp:input.clientIp,quotaBytes:quotaBytes?.toString()??null,quotaPeriod:quotaBytes?input.quotaPeriod:null,bandwidthMode:input.bandwidthMode}});return ok({id})}catch(error){if(error instanceof ReconciliationConflictError)return fail(error.message,409,error.observed);return handleApiError(error)}}
