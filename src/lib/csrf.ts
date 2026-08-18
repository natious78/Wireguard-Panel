import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import { env } from "./env";
import { opaqueToken, safeEqual } from "./security";

export const CSRF_COOKIE = "wg_csrf";

export function issueCsrf(response: NextResponse) {
  const token = opaqueToken(24);
  response.cookies.set(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: "strict",
    secure: new URL(env().APP_URL).protocol === "https:",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
  return token;
}

export async function validateCsrf(request: NextRequest) {
  const cookieToken = (await cookies()).get(CSRF_COOKIE)?.value;
  const headerToken = request.headers.get("x-csrf-token");
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) return false;

  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    const forwardedHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
    return originUrl.host === forwardedHost;
  } catch {
    return false;
  }
}
