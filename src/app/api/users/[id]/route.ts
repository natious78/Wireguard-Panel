import {NextRequest} from "next/server";
import {z} from "zod";
import {audit} from "@/lib/audit";
import {fail,handleApiError,ok} from "@/lib/api";
import {requireUser} from "@/lib/auth";
import {validateCsrf} from "@/lib/csrf";
import {updateManagedUser} from "@/server/user-service";

const schema=z.object({role:z.enum(["super_admin","administrator","read_only"]),enabled:z.boolean(),password:z.string().min(12).max(256).nullable().optional()});
export async function PUT(request:NextRequest,context:{params:Promise<{id:string}>}){const auth=await requireUser("user:manage");if(!auth.user)return fail(auth.error,auth.status);if(!(await validateCsrf(request)))return fail("Security token expired.",403);try{const{id}=await context.params;const input=schema.parse(await request.json());const result=await updateManagedUser(id,input,auth.user.id);await audit({user:auth.user,action:"user_updated",result:"success",details:{targetUserId:id,username:result.username,role:result.role,enabled:result.enabled,passwordChanged:result.passwordChanged}});return ok(result)}catch(error){return handleApiError(error)}}
