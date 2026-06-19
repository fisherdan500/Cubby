import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(code: string, message: string, status = 400, fieldErrors?: unknown) {
  return NextResponse.json({ ok: false, error: { code, message, fieldErrors } }, { status });
}

export function handleError(error: unknown) {
  if (error instanceof ZodError) {
    return fail("validation_error", "Please check the highlighted fields.", 422, error.flatten());
  }
  if (error instanceof Error) {
    if (error.message === "unauthenticated") return fail("unauthenticated", "Please sign in.", 401);
    if (error.message === "forbidden") return fail("forbidden", "You do not have access.", 403);
    if (error.message === "not_found") return fail("not_found", "Not found.", 404);
  }
  console.error(error);
  return fail("server_error", "Something went wrong.", 500);
}
