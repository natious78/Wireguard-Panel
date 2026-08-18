import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, handleApiError, ok } from "@/lib/api";
import { clientForRouter, getRouter } from "@/server/router-repository";

export async function POST(request:NextRequest,context:{params:Promise<{id:string}>}){
 const auth=await requireUser("write");if(!auth.user)return fail(auth.error,auth.status);if(!(await validateCsrf(request)))return fail("Security token expired.",403);const {id}=await context.params;
 try{const router=await getRouter(id);const client=clientForRouter(router);try{const facts=await client.testConnection();const interfaces=await client.getInterfaces();await audit({user:auth.user,action:"router_connection_tested",routerId:id,result:"success"});return ok({status:"connected",facts,interfaces})}finally{await client.close()}}catch(error){return handleApiError(error)}
}
