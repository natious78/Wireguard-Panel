import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, handleApiError, ok } from "@/lib/api";
import { ReconciliationConflictError, updatePeer } from "@/server/peer-service";

const schema=z.object({name:z.string().trim().min(2).max(100),description:z.string().trim().max(500).optional(),allowedAddress:z.string().trim().min(3),clientAllowedIps:z.string().trim().min(3),dnsServer:z.string().trim().min(1),persistentKeepalive:z.coerce.number().int().min(0).max(65535),mtu:z.coerce.number().int().min(576).max(9000),expiresAt:z.string().datetime().nullable().optional().transform(v=>v?new Date(v):null),endpointOverride:z.string().trim().max(255).nullable().optional(),endpointPortOverride:z.coerce.number().int().min(1).max(65535).nullable().optional()});
export async function PUT(request:NextRequest,context:{params:Promise<{id:string}>}){const auth=await requireUser("write");if(!auth.user)return fail(auth.error,auth.status);if(!(await validateCsrf(request)))return fail("Security token expired.",403);const {id}=await context.params;try{const input=schema.parse(await request.json());await updatePeer(id,input);await audit({user:auth.user,action:"peer_edited",peerId:id,result:"success",details:{name:input.name}});return ok({id})}catch(error){if(error instanceof ReconciliationConflictError)return fail(error.message,409,error.observed);return handleApiError(error)}}
