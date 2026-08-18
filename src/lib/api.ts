import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { redactError } from "./security";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ data }, init);
}

export function fail(error: string, status = 400, details?: unknown) {
  return NextResponse.json({ error, ...(details ? { details } : {}) }, { status });
}

export function handleApiError(error: unknown) {
  if (error instanceof ZodError) {
    return fail("Check the highlighted fields and try again.", 422, error.flatten());
  }
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (code === "23505") return fail("That value is already in use. Refresh the page and choose another value.", 409);
  return fail(redactError(error), 500);
}
