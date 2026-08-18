import { cookies, headers } from "next/headers";
import type { NextResponse } from "next/server";
import { query } from "./db";
import { env } from "./env";
import { hashToken, opaqueToken, verifyPassword } from "./security";

export const SESSION_COOKIE = "wg_session";

export type SessionUser = {
  id: string;
  username: string;
  role: "admin" | "operator" | "viewer";
};

export async function authenticate(username: string, password: string): Promise<SessionUser | null> {
  const result = await query<SessionUser & { password_hash: string; enabled: boolean }>(
    "SELECT id, username, role, password_hash, enabled FROM users WHERE lower(username) = lower($1)",
    [username],
  );
  const user = result.rows[0];
  if (!user?.enabled || !(await verifyPassword(password, user.password_hash))) return null;
  await query("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1", [user.id]);
  return { id: user.id, username: user.username, role: user.role };
}

export async function createSession(userId: string) {
  const token = opaqueToken();
  const expiresAt = new Date(Date.now() + env().SESSION_TTL_HOURS * 60 * 60 * 1000);
  const requestHeaders = await headers();
  await query(
    `INSERT INTO sessions(user_id, token_hash, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId,
      hashToken(token),
      expiresAt,
      clientIp(requestHeaders),
      requestHeaders.get("user-agent")?.slice(0, 400) ?? null,
    ],
  );
  return { token, expiresAt };
}

export function setSessionCookie(response: NextResponse, token: string, expires: Date) {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: new URL(env().APP_URL).protocol === "https:",
    sameSite: "strict",
    path: "/",
    expires,
  });
}

export async function getSession(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const result = await query<SessionUser>(
    `SELECT u.id, u.username, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.enabled = true`,
    [hashToken(token)],
  );
  const user = result.rows[0] ?? null;
  if (user) {
    await query("UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1", [hashToken(token)]);
  }
  return user;
}

export async function destroySession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

export function can(user: SessionUser, permission: "read" | "write" | "delete" | "settings") {
  if (user.role === "admin") return true;
  if (user.role === "operator") return permission === "read" || permission === "write";
  return permission === "read";
}

export function clientIp(requestHeaders: Headers) {
  return requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || requestHeaders.get("x-real-ip") || "unknown";
}

export async function requireUser(permission: "read" | "write" | "delete" | "settings" = "read") {
  const user = await getSession();
  if (!user) return { user: null, status: 401 as const, error: "Authentication required." };
  if (!can(user, permission)) return { user: null, status: 403 as const, error: "You do not have permission for this action." };
  return { user, status: 200 as const, error: null };
}

export async function loginRateLimit(identity: string) {
  const result = await query<{ attempt_count: number; blocked_until: Date | null }>(
    `SELECT attempt_count, blocked_until FROM login_attempts WHERE identity = $1`,
    [identity],
  );
  const entry = result.rows[0];
  return {
    blocked: Boolean(entry?.blocked_until && new Date(entry.blocked_until).getTime() > Date.now()),
    retryAfter: entry?.blocked_until ? Math.max(1, Math.ceil((new Date(entry.blocked_until).getTime() - Date.now()) / 1000)) : 0,
  };
}

export async function recordLoginFailure(identity: string) {
  await query(
    `INSERT INTO login_attempts(identity, attempt_count, window_started_at, blocked_until, updated_at)
     VALUES ($1, 1, now(), NULL, now())
     ON CONFLICT (identity) DO UPDATE SET
       attempt_count = CASE WHEN login_attempts.window_started_at < now() - interval '15 minutes' THEN 1 ELSE login_attempts.attempt_count + 1 END,
       window_started_at = CASE WHEN login_attempts.window_started_at < now() - interval '15 minutes' THEN now() ELSE login_attempts.window_started_at END,
       blocked_until = CASE
         WHEN (CASE WHEN login_attempts.window_started_at < now() - interval '15 minutes' THEN 1 ELSE login_attempts.attempt_count + 1 END) >= 5
         THEN now() + interval '15 minutes' ELSE login_attempts.blocked_until END,
       updated_at = now()`,
    [identity],
  );
}

export async function clearLoginFailures(identity: string) {
  await query("DELETE FROM login_attempts WHERE identity = $1", [identity]);
}
