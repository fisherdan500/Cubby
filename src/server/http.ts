import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { MAX_BACKUP_BYTES } from "@/server/services/backup-format";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(code: string, message: string, status = 400, fieldErrors?: unknown) {
  return NextResponse.json({ ok: false, error: { code, message, fieldErrors } }, { status });
}

export async function readBoundedJson(request: Request, maxBytes = MAX_BACKUP_BYTES) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("backup_invalid_content_type");
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("backup_too_large");
  if (!request.body) throw new Error("backup_invalid_json");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("backup_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("backup_invalid_json");
  }
}

export function handleError(error: unknown) {
  if (error instanceof ZodError) return fail("validation_error", "Please check the highlighted fields.", 422, error.flatten());
  if (error instanceof Error) {
    if (error.message === "unauthenticated") return fail("unauthenticated", "Please sign in.", 401);
    if (error.message === "forbidden") return fail("forbidden", "You do not have access.", 403);
    if (error.message === "email_not_verified") return fail("email_not_verified", "Verify your email before creating a household.", 403);
    if (error.message === "platform_uninitialized") return fail("platform_uninitialized", "Platform authority is not initialized.", 409);
    if (error.message === "not_found") return fail("not_found", "Not found.", 404);
    if (error.message === "baby_inactive") return fail("baby_inactive", "Inactive babies cannot receive new activity or timers.", 409);
    if (error.message === "baby_has_active_timer") return fail("baby_has_active_timer", "Stop or end every running or paused timer before deactivating this baby.", 409);
    if (error.message === "backup_active_timer") return fail("backup_active_timer", "This backup contains a running or paused timer. Stop it before exporting a new backup.", 409);
    if (error.message === "backup_invalid_timer") return fail("backup_invalid_timer", "This backup contains invalid timer history and cannot be restored.", 422);
    if (error.message === "backup_invalid_content_type") return fail("backup_invalid_content_type", "Upload a JSON backup with application/json content type.", 415);
    if (error.message === "backup_invalid_json") return fail("backup_invalid_json", "The selected file is not valid JSON.", 422);
    if (error.message === "backup_invalid") return fail("backup_invalid", "The selected file is not a valid Cubby backup.", 422);
    if (error.message === "backup_duplicate_source_id") return fail("backup_duplicate_source_id", "The backup contains duplicate source records and cannot be restored.", 422);
    if (error.message === "backup_dangling_reference") return fail("backup_dangling_reference", "The backup contains a reference to a missing record and cannot be restored.", 422);
    if (error.message === "backup_too_large") return fail("backup_too_large", "Cubby backup files must be 25 MiB or smaller.", 413);
    if (error.message === "backup_target_not_empty") return fail("backup_target_not_empty", "Restore requires a fresh household with only its current owner.", 409);
    if (error.message === "backup_checksum_mismatch") return fail("backup_checksum_mismatch", "The backup checksum does not match its contents.", 422);
    if (error.message === "backup_unsupported_version") return fail("backup_unsupported_version", "This Cubby backup version is not supported.", 422);
    if (error.message === "backup_confirmation_mismatch") return fail("backup_confirmation_mismatch", "Type the current household name exactly to confirm restore.", 422);
    if (error.message === "backup_preview_mismatch") return fail("backup_preview_mismatch", "The selected backup changed after preview. Preview it again.", 409);
    if (error.message === "backup_restore_retry") return fail("backup_restore_retry", "The household changed during restore. Preview the backup and try again.", 409);
    if (error.message === "missing_file") return fail("missing_file", "Choose a backup file to upload.", 422);
    if (error.message === "file_too_large") return fail("file_too_large", "Backup files must be 100 MB or smaller.", 413);
    if (error.message === "invalid_sqlite_backup") return fail("invalid_sqlite_backup", "That file is not a valid SQLite backup.", 422);
    if (error.message === "sprout_sqlite_unavailable") return fail("sprout_sqlite_unavailable", "Cubby could not start the Sprout SQLite reader. Rebuild and restart the app, then try the import again.", 500);
    if (error.message === "unsupported_sprout_backup") return fail("unsupported_sprout_backup", "Upload a Sprout Track zip, baby-tracker.db, or data.json backup.", 422);
  }
  console.error(error);
  return fail("server_error", "Something went wrong.", 500);
}
