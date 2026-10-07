import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { trustedOrigins } from "@/lib/env";
import { MAX_BACKUP_BYTES } from "@/server/services/backup-format";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(code: string, message: string, status = 400, fieldErrors?: unknown) {
  return NextResponse.json({ ok: false, error: { code, message, fieldErrors } }, { status });
}

export function authorizedRequestOrigin(request: Request, options: { requireOrigin?: boolean } = {}) {
  const origin = request.headers.get("origin");
  const internalOrigin = new URL(request.url).origin;
  if (!origin) {
    if (options.requireOrigin) throw new Error("forbidden");
    return internalOrigin;
  }
  if (origin !== internalOrigin && !trustedOrigins().includes(origin)) throw new Error("forbidden");
  return origin;
}

export async function readBoundedJson(request: Request, maxBytes = MAX_BACKUP_BYTES) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("backup_invalid_content_type");
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error("backup_too_large");
  if (!request.body) throw new Error("backup_invalid_json");
  if (request.signal.aborted) throw new Error("backup_upload_aborted");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let failure: Error | undefined;
  let cancellation: Promise<void> | undefined;
  const stop = (code: string) => {
    failure ??= new Error(code);
    cancellation ??= reader.cancel(failure).catch(() => undefined);
  };
  const onAbort = () => stop("backup_upload_aborted");
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("backup_upload_timeout"), 120_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (failure) throw failure;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("backup_too_large");
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    await (cancellation ?? reader.cancel().catch(() => undefined));
    reader.releaseLock();
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

/** Whether an upload is a backup archive (a .zip with photos) rather than a JSON backup. */
export function isBackupArchiveUpload(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  // Windows browsers label .zip files application/x-zip-compressed.
  return contentType === "application/zip" || contentType === "application/x-zip-compressed";
}

/** A raw request body, refused as soon as it passes `maxBytes` rather than after reading it all. */
export async function readBoundedBytes(request: Request, maxBytes: number, tooLargeCode: string) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error(tooLargeCode);
  if (!request.body) return Buffer.alloc(0);
  if (request.signal.aborted) throw new Error("upload_aborted");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let failure: Error | undefined;
  let cancellation: Promise<void> | undefined;
  const stop = (code: string) => {
    failure ??= new Error(code);
    cancellation ??= reader.cancel(failure).catch(() => undefined);
  };
  const onAbort = () => stop("upload_aborted");
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("upload_timeout"), 120_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (failure) throw failure;
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(tooLargeCode);
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    await (cancellation ?? reader.cancel().catch(() => undefined));
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Database failures that are the server's problem and worth retrying, not the caller's mistake.
 *
 * Prisma reports these on `code` rather than in `message`, so they do not match any of the string
 * comparisons below and would otherwise fall through to the catch-all. A long restore is where they
 * bite: it holds one serializable transaction across thousands of rows, so an exhausted pool or a
 * closed transaction is a realistic outcome on a busy or underpowered server. Told plainly, the
 * person retries; told "Something went wrong", they have no idea whether their data arrived.
 *
 * Deliberately narrow. Only transient infrastructure codes are listed - a constraint violation or a
 * missing record is a bug and must keep reaching the catch-all, where it is logged.
 */
const RETRYABLE_DATABASE_CODES = new Map([
  ["P2024", "Cubby could not get a database connection in time. Wait a moment, then try again."],
  ["P2028", "The database stopped partway through this operation, so nothing was saved. Try again."],
  ["P2034", "The database was too busy to finish this safely, so nothing was saved. Try again."],
  ["P1001", "Cubby cannot reach its database. Check that the database is running, then try again."],
  ["P1002", "Cubby cannot reach its database. Check that the database is running, then try again."],
  ["P1008", "The database took too long to respond, so nothing was saved. Try again."],
  ["P1017", "The database closed the connection, so nothing was saved. Try again."]
]);

function retryableDatabaseFailure(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  if (typeof code !== "string") return null;
  const message = RETRYABLE_DATABASE_CODES.get(code);
  return message ? { code, message } : null;
}

export function handleError(error: unknown) {
  if (error instanceof ZodError) return fail("validation_error", "Please check the highlighted fields.", 422, error.flatten());
  const database = retryableDatabaseFailure(error);
  if (database) {
    // Logged as well as reported: a pool timeout on an ordinary request is a capacity signal.
    console.error(error);
    return fail("database_unavailable", database.message, 503);
  }
  if (error instanceof Error) {
    if (error.message === "unauthenticated") return fail("unauthenticated", "Please sign in.", 401);
    if (error.message === "password_change_required") return fail("password_change_required", "Choose your own password before continuing.", 403);
    if (error.message === "validation_error") return fail("validation_error", "Please check the submitted request.", 422);
    if (error.message === "forbidden") return fail("forbidden", "You do not have access.", 403);
    if (error.message === "fresh_authentication_required") return fail("fresh_authentication_required", "Sign in again to continue.", 403);
    if (error.message === "household_selection_required") return fail("household_selection_required", "Select a household to continue.", 409);
    if (error.message === "household_selection_stale") return fail("household_selection_stale", "Your selected household is no longer available. Choose another household.", 409);
    if (error.message === "invite_membership_conflict") return fail("invite_membership_conflict", "This invitation cannot change an existing or suspended membership. Ask the household owner to review access.", 409);
    if (error.message === "invite_expiry_invalid") return fail("invite_expiry_invalid", "Choose an allowed invitation expiry.", 422);
    if (error.message === "bulk_invite_revoke_acknowledgement_required") return fail("bulk_invite_revoke_acknowledgement_required", "Type the exact acknowledgement to revoke all pending invitations.", 422);
    if (error.message === "household_owner_cannot_leave") return fail("household_owner_cannot_leave", "The protected household owner must transfer ownership before leaving.", 409);
    if (error.message === "household_leave_confirmation_mismatch") return fail("household_leave_confirmation_mismatch", "Type the household name exactly to confirm leaving.", 422);
    if (error.message === "household_leave_operation_reused") return fail("household_leave_operation_reused", "This leave operation belongs to an earlier membership. Start a new leave request.", 409);
    if (error.message === "suspended_membership_must_leave") return fail("suspended_membership_must_leave", "Leave your suspended household membership before creating another household.", 409);
    if (error.message === "email_not_verified") return fail("email_not_verified", "Verify your email before creating a household.", 403);
    if (error.message === "platform_uninitialized") return fail("platform_uninitialized", "Platform authority is not initialized.", 409);
    if (error.message === "platform_setup_code_invalid") return fail("platform_setup_code_invalid", "That setup code isn't valid. Copy the latest code from the Cubby container log - each one works once, expires after 24 hours, and restarting Cubby issues a new one.", 422);
    if (error.message === "platform_owner_already_bound") return fail("platform_owner_already_bound", "Cubby already has a platform owner.", 409);
    if (error.message === "platform_setup_account_ineligible") return fail("platform_setup_account_ineligible", "Sign in with an email-and-password account to claim setup.", 403);
    if (error.message === "platform_setup_retry") return fail("platform_setup_retry", "Setup was busy for a moment. Try again.", 409);
    if (error.message === "platform_setup_install_not_empty") return fail("platform_setup_install_not_empty", "Cubby already has an account. Sign in with it to finish setup.", 409);
    if (error.message === "platform_setup_account_invalid") return fail("platform_setup_account_invalid", "Enter your name, a valid email address, and a password of 8 to 128 characters.", 422);
    if (error.message === "not_found") return fail("not_found", "Not found.", 404);
    if (error.message === "baby_inactive") return fail("baby_inactive", "Inactive babies cannot receive new activity or timers.", 409);
    if (error.message === "stale_revision") return fail("stale_revision", "This item changed before your request completed. Refresh and try again.", 409);
    if (error.message === "idempotency_conflict") return fail("idempotency_conflict", "This submission key belongs to a different activity request.", 409);
    if (error.message === "baby_has_active_timer") return fail("baby_has_active_timer", "Stop or end every running or paused timer before deactivating this baby.", 409);
    if (error.message === "confirmation_mismatch") return fail("confirmation_mismatch", "Type the confirmation phrase exactly as shown.", 422);
    if (error.message === "baby_has_history") return fail("baby_has_history", "This baby now has history, so it can no longer be removed outright. Hide it instead to keep its history.", 409);
    if (error.message === "baby_birth_date_invalid") return fail("baby_birth_date_invalid", "Enter a valid birth date.", 422);
    if (error.message === "backup_upload_busy") return fail("backup_upload_busy", "Another backup upload is in progress. Try again when it finishes.", 429);
    if (error.message === "backup_upload_timeout") return fail("backup_upload_timeout", "The backup upload took too long. Try again.", 408);
    if (error.message === "backup_upload_aborted") return fail("backup_upload_aborted", "The backup upload was cancelled.", 408);
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
    if (error.message === "sprout_preview_required") return fail("sprout_preview_required", "Preview this Sprout backup before importing it.", 422);
    if (error.message === "sprout_preview_mismatch") return fail("sprout_preview_mismatch", "The selected Sprout backup changed after preview. Preview it again.", 409);
    if (error.message === "sprout_preview_expired") return fail("sprout_preview_expired", "This Sprout preview has expired. Upload it again to continue.", 409);
    if (error.message === "sprout_import_failed") return fail("sprout_import_failed", "The Sprout import could not be processed.", 422);
    if (error.message === "backup_restore_retry") return fail("backup_restore_retry", "The household changed during restore. Preview the backup and try again.", 409);
    if (error.message === "missing_file") return fail("missing_file", "Choose a backup file to upload.", 422);
    if (error.message === "file_too_large") return fail("file_too_large", "Backup files must be 100 MB or smaller.", 413);
    if (error.message === "invalid_sqlite_backup") return fail("invalid_sqlite_backup", "That file is not a valid SQLite backup.", 422);
    if (error.message === "sprout_sqlite_unavailable") return fail("sprout_sqlite_unavailable", "Cubby could not start the Sprout SQLite reader. Rebuild and restart the app, then try the import again.", 500);
    if (error.message === "backup_photos_missing") return fail("backup_photos_missing", "This backup lists photos that are not in the file. Choose the .zip backup, which includes them.", 422);
    if (error.message === "backup_photo_mismatch") return fail("backup_photo_mismatch", "A photo in this backup does not match what the backup lists, so the file is damaged. Try another backup.", 422);
    if (error.message === "backup_photo_unavailable") return fail("backup_photo_unavailable", "A photo could not be read, so the backup was not made. Run the integrity check, then try again.", 409);
    if (error.message === "backup_audit_integrity_unavailable") return fail("backup_audit_integrity_unavailable", "This household's audit history could not be verified, so restoring into it was refused. Run the integrity check to see why, then try again.", 409);
    if (error.message === "backup_invalid_pause_intervals" || error.message === "pause_interval_state_invalid") return fail("backup_invalid_pause_intervals", "This backup contains a timer whose pause history is incomplete and cannot be restored.", 422);
    if (error.message === "archive_too_large") return fail("archive_too_large", "Cubby backup archives must be 2 GiB or smaller.", 413);
    if (error.message === "backup_too_large_to_restore") return fail("backup_too_large_to_restore", "This backup holds more history than Cubby can restore in one go. Keep the file safely - it is still a complete copy - and see Moving One Household To A New Cubby in the install guide for how to bring it in. Retrying will not help.", 413);
    if (error.message === "backup_directory_unavailable") return fail("backup_directory_unavailable", "Cubby cannot reach its backup folder (AUTOMATED_BACKUP_DIRECTORY). Check it on the platform page, then try again.", 503);
    if (error.message === "attachment_type_unavailable") return fail("not_found", "Not found.", 404);
    if (error.message === "attachment_upload_busy") return fail("attachment_upload_busy", "Another photo is being processed. Try again shortly.", 429);
    if (error.message === "upload_timeout" || error.message === "upload_aborted") return fail(error.message, "The upload stopped. Try again.", 408);
    if (error.message === "attachment_staging_full") return fail("attachment_staging_full", "Photo staging is full. Share pending photos or try again after cleanup.", 429);
    if (error.message === "attachment_too_large") return fail("attachment_too_large", "Photos must be 25 MB or smaller.", 413);
    if (error.message === "attachment_unsupported_format") return fail("attachment_unsupported_format", "Choose a JPEG, PNG or WebP photo.", 415);
    if (error.message === "attachment_invalid_selection") return fail("attachment_invalid_selection", "A post can have up to 10 photos.", 422);
    if (error.message.startsWith("attachment_store_")) return fail("attachment_store_unavailable", "Photos can't be saved right now. Try again later.", 503);
    if (error.message === "unsupported_sprout_backup") return fail("unsupported_sprout_backup", "Upload a Sprout Track zip, baby-tracker.db, or data.json backup.", 422);
  }
  console.error(error);
  return fail("server_error", "Something went wrong.", 500);
}
