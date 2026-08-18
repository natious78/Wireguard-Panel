import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, handleApiError, ok } from "@/lib/api";
import { ReconciliationConflictError, regeneratePeerKeys } from "@/server/peer-service";
const schema=z.object({usePresharedKey:z.boolean().default(false)});
export async function POST(request:NextRequest,context:{params:Promise<{id:string}>}){const auth=await requireUser("write");if(!auth.user)return fail(auth.error,auth.status);if(!(await validateCsrf(request)))return fail("Security token expired.",403);const {id}=await context.params;try{const input=schema.parse(await request.json());await regeneratePeerKeys(id,input.usePresharedKey);await audit({user:auth.user,action:"peer_keys_regenerated",peerId:id,result:"success"});return ok({id})}catch(error){if(error instanceof ReconciliationConflictError)return fail(error.message,409,error.observed);return handleApiError(error)}}
