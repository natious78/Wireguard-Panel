import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, handleApiError, ok } from "@/lib/api";
import { interfaceUpdateSchema } from "@/lib/validation";
import { createInterface } from "@/server/interface-service";

const schema = z.object({ routerId:z.string().uuid() }).and(interfaceUpdateSchema);
export async function POST(request:NextRequest){
  const auth=await requireUser("write"); if(!auth.user)return fail(auth.error,auth.status);
  if(!(await validateCsrf(request)))return fail("Security token expired.",403);
  try{const input=schema.parse(await request.json()); const id=await createInterface(input.routerId,input);
    await audit({user:auth.user,action:"interface_created",routerId:input.routerId,result:"success",details:{name:input.name}}); return ok({id},{status:201});
  }catch(error){return handleApiError(error)}
}
