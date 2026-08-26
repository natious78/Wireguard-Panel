import {NextRequest} from "next/server";
import {z} from "zod";
import {audit} from "@/lib/audit";
import {fail,handleApiError,ok} from "@/lib/api";
import {requireUser} from "@/lib/auth";
import {validateCsrf} from "@/lib/csrf";
import {createManagedUser} from "@/server/user-service";

const schema=z.object({username:z.string().min(3).max(64),password:z.string().min(12).max(256),role:z.enum(["super_admin","administrator","read_only"])});
export async function POST(request:NextRequest){const auth=await requireUser("user:manage");if(!auth.user)return fail(auth.error,auth.status);if(!(await validateCsrf(request)))return fail("Security token expired.",403);try{const input=schema.parse(await request.json());const id=await createManagedUser(input);await audit({user:auth.user,action:"user_created",result:"success",details:{targetUserId:id,username:input.username,role:input.role}});return ok({id},{status:201})}catch(error){return handleApiError(error)}}
