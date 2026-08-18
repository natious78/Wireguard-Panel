import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, handleApiError, ok } from "@/lib/api";
import { interfaceUpdateSchema } from "@/lib/validation";
import { updateInterface } from "@/server/interface-service";
import { ReconciliationConflictError } from "@/server/peer-service";

export async function PUT(request:NextRequest,context:{params:Promise<{id:string}>}){
  const auth=await requireUser("write");if(!auth.user)return fail(auth.error,auth.status);
  if(!(await validateCsrf(request)))return fail("Security token expired.",403);
  const {id}=await context.params;
  try{const input=interfaceUpdateSchema.parse(await request.json());await updateInterface(id,input);
    await audit({user:auth.user,action:"interface_edited",result:"success",details:{name:input.name}});return ok({id});
  }catch(error){if(error instanceof ReconciliationConflictError)return fail(error.message,409,error.observed);return handleApiError(error)}
}
