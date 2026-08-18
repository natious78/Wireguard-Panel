import { NextRequest, NextResponse } from "next/server";
import { destroySession, getSession, SESSION_COOKIE } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";

export async function POST(request: NextRequest) {
  if (!(await validateCsrf(request))) return NextResponse.json({ error: "Security token expired." }, { status: 403 });
  const user = await getSession();
  await destroySession();
  const response = NextResponse.json({ data: { ok: true } });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", expires: new Date(0), httpOnly: true, sameSite: "strict" });
  if (user) await audit({ user, action: "logout", result: "success" });
  return response;
}
