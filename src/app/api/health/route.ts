import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export async function GET() {
  const started = Date.now();
  try {
    await pool.query("SELECT 1");
    return NextResponse.json({ status: "healthy", application: "ok", database: "ok", latencyMs: Date.now() - started }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ status: "unhealthy", application: "ok", database: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
