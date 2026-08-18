import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";import { validateCsrf } from "@/lib/csrf";import { audit } from "@/lib/audit";import { fail,handleApiError,ok } from "@/lib/api";
import { poolSchema } from "@/lib/validation";import { createPool } from "@/server/pool-service";
export async function POST(request:NextRequest){const auth=await requireUser("settings");if(!auth.user)return fail(auth.error,auth.status);if(!(await validateCsrf(request)))return fail("Security token expired.",403);
 try{const input=poolSchema.parse(await request.json());const id=await createPool({...input,userId:auth.user.id});await audit({user:auth.user,action:"wireguard_pool_created",routerId:input.routerId,result:"success",details:{poolId:id,name:input.name,network:input.networkCidr,range:`${input.startIp}-${input.endIp}`}});return ok({id},{status:201})}catch(error){return handleApiError(error)}}
