import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, clearLoginFailures, clientIp, createSession, loginRateLimit, recordLoginFailure, setSessionCookie } from "@/lib/auth";
import { validateCsrf } from "@/lib/csrf";
import { audit } from "@/lib/audit";

const loginSchema = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(512) });

export async function POST(request: NextRequest) {
  if (!(await validateCsrf(request))) return NextResponse.json({ error: "Security token expired. Refresh the page and try again." }, { status: 403 });
  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter your username and password." }, { status: 422 });
  const identity = `${clientIp(request.headers)}:${parsed.data.username.toLowerCase()}`;
  const limit = await loginRateLimit(identity);
  if (limit.blocked) {
    return NextResponse.json({ error: "Too many failed sign-in attempts. Try again later." }, { status: 429, headers: { "Retry-After": String(limit.retryAfter) } });
  }
  const user = await authenticate(parsed.data.username, parsed.data.password);
  if (!user) {
    await recordLoginFailure(identity);
    await audit({ action: "login_failed", result: "failure", details: { username: parsed.data.username } });
    return NextResponse.json({ error: "The username or password is incorrect." }, { status: 401 });
  }
  await clearLoginFailures(identity);
  const session = await createSession(user.id);
  const response = NextResponse.json({ data: { user: { username: user.username, role: user.role } } });
  setSessionCookie(response, session.token, session.expiresAt);
  await audit({ user, action: "login", result: "success" });
  return response;
}
