import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";
import { fail, handleApiError, ok } from "@/lib/api";
import { query } from "@/lib/db";
const schema=z.object({onlineSeconds:z.coerce.number().int().min(30).max(3600),recentSeconds:z.coerce.number().int().min(60).max(86400)}).refine(v=>v.recentSeconds>v.onlineSeconds,{message:"Recently active threshold must be greater than online threshold."});
export async function PUT(request:NextRequest){const auth=await requireUser("settings");if(!auth.user)return fail(auth.error,auth.status);if(!(await validateCsrf(request)))return fail("Security token expired.",403);try{const value=schema.parse(await request.json());await query(`INSERT INTO settings(key,value,updated_by,updated_at) VALUES('status_thresholds',$1,$2,now()) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=now()`,[JSON.stringify(value),auth.user.id]);await audit({user:auth.user,action:"settings_updated",result:"success",details:value});return ok(value)}catch(error){return handleApiError(error)}}
