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
    if (error.message === "missing_file") return fail("missing_file", "Choose a backup file to upload.", 422);
    if (error.message === "file_too_large") return fail("file_too_large", "Backup files must be 100 MB or smaller.", 413);
    if (error.message === "invalid_sqlite_backup") return fail("invalid_sqlite_backup", "That file is not a valid SQLite backup.", 422);
    if (error.message === "sprout_sqlite_unavailable") {
      return fail("sprout_sqlite_unavailable", "Cubby could not start the Sprout SQLite reader. Rebuild and restart the app, then try the import again.", 500);
    }
    if (error.message === "unsupported_sprout_backup") {
      return fail("unsupported_sprout_backup", "Upload a Sprout Track zip, baby-tracker.db, or data.json backup.", 422);
    }
  }
  console.error(error);
  return fail("server_error", "Something went wrong.", 500);
}
