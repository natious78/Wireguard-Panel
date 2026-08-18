import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";import { validateCsrf } from "@/lib/csrf";import { audit } from "@/lib/audit";import { fail,handleApiError,ok } from "@/lib/api";
import { poolSchema } from "@/lib/validation";import { deletePool,updatePool } from "@/server/pool-service";
export async function PUT(request:NextRequest,context:{params:Promise<{id:string}>}){const auth=await requireUser("settings");if(!auth.user)return fail(auth.error,auth.status);if(!(await validateCsrf(request)))return fail("Security token expired.",403);const{id}=await context.params;
 try{const input=poolSchema.parse(await request.json());await updatePool(id,{...input,userId:auth.user.id});await audit({user:auth.user,action:"wireguard_pool_updated",routerId:input.routerId,result:"success",details:{poolId:id,name:input.name}});return ok({id})}catch(error){return handleApiError(error)}}
export async function DELETE(request:NextRequest,context:{params:Promise<{id:string}>}){const auth=await requireUser("settings");if(!auth.user)return fail(auth.error,auth.status);if(!(await validateCsrf(request)))return fail("Security token expired.",403);const{id}=await context.params;
 try{await deletePool(id);await audit({user:auth.user,action:"wireguard_pool_deleted",result:"success",details:{poolId:id}});return ok({id})}catch(error){return handleApiError(error)}}
