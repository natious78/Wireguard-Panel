import { NextResponse } from "next/server";
import { issueCsrf } from "@/lib/csrf";

export const dynamic = "force-dynamic";

export async function GET() {
  const response = NextResponse.json({ data: { csrfToken: "issued" } });
  issueCsrf(response);
  return response;
}
