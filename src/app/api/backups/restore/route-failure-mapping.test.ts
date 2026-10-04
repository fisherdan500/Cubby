/**
 * What the person is told when a restore goes wrong.
 *
 * The service-level matrix proves which refusals the backup services perform. It cannot prove what
 * reaches the person, because the error mapping lives in the route. This file covers that gap: it
 * drives the real POST handler with real Request objects and asserts the response body.
 *
 * The case that matters is the LAST one. `handleError` (src/server/http.ts) is a chain of string
 * equality checks on `error.message` ending in a catch-all that returns "Something went wrong." - the
 * exact message reported from a live instance during a migration. A Prisma failure carries its detail
 * in `code`, not in a bare `message`, so a pool timeout or a database trigger raise during a large
 * restore lands on that catch-all. These tests pin which errors are explained and which are not, so
 * the gap is visible in CI rather than discovered during somebody's migration.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: async () => ({ role: "owner" }),
  requirePermission: vi.fn()
}));

const mocks = vi.hoisted(() => ({
  restoreBackupJson: vi.fn(),
  restoreBackupArchive: vi.fn(),
  withUpload: vi.fn()
}));
vi.mock("@/server/services/backups", () => ({
  restoreBackupJson: mocks.restoreBackupJson,
  restoreBackupArchive: mocks.restoreBackupArchive
}));
vi.mock("@/server/services/backup-upload", () => ({
  withBackupUploadAdmission: (work: () => Promise<unknown>) => work(),
  withUploadedBackupArchive: mocks.withUpload
}));

import { POST } from "@/app/api/backups/restore/route";

/** A restore request shaped the way the browser sends one. */
function restoreRequest(options: {
  body?: string;
  contentType?: string;
  confirmation?: string | null;
  checksum?: string | null;
} = {}) {
  const headers = new Headers();
  headers.set("content-type", options.contentType ?? "application/json");
  if (options.confirmation !== null) {
    headers.set("x-cubby-restore-confirmation", encodeURIComponent(options.confirmation ?? "A Household"));
  }
  if (options.checksum !== null) headers.set("x-cubby-backup-checksum", options.checksum ?? "checksum");
  return new Request("http://localhost/api/backups/restore", {
    method: "POST",
    headers,
    body: options.body ?? JSON.stringify({ format: "cubby-household-backup", version: 2 })
  });
}

async function readBody(response: Response) {
  return (await response.json()) as { ok: boolean; error?: { code: string; message: string } };
}

describe("POST /api/backups/restore - what the person is told when it fails", () => {
  beforeEach(() => vi.clearAllMocks());

  it("explains every refusal the restore services perform", async () => {
    // Each of these is a deliberate refusal with a reason worth reading, and each is a string the
    // restore services genuinely throw (verified against src/server/services/backups.ts and
    // backup-format.ts, not invented). None may arrive as the catch-all: a person who is told
    // "Something went wrong" cannot act, and a migration onto a new server is the likeliest moment to
    // meet one.
    const refusals = [
      "backup_checksum_mismatch",
      "backup_confirmation_mismatch",
      "backup_preview_mismatch",
      "backup_photos_missing",
      "backup_invalid",
      "backup_unsupported_version",
      "backup_target_not_empty",
      "backup_active_timer",
      "backup_invalid_timer",
      "backup_invalid_pause_intervals",
      "backup_duplicate_source_id",
      "backup_dangling_reference",
      "backup_photo_unavailable",
      "backup_audit_integrity_unavailable",
      "backup_upload_busy",
      "backup_upload_timeout",
      "backup_upload_aborted",
      "backup_restore_retry"
    ];

    const unexplained: string[] = [];
    for (const code of refusals) {
      mocks.restoreBackupJson.mockRejectedValueOnce(new Error(code));
      const body = await readBody(await POST(restoreRequest()));
      if (body.error?.code === "server_error") unexplained.push(code);
      // Whatever the code maps to, the person must get a sentence rather than a raw identifier.
      expect(body.ok).toBe(false);
      expect(body.error?.message ?? "").not.toMatch(/^backup_/);
    }
    expect(unexplained).toEqual([]);
  });

  it("explains a missing confirmation header before it reads the body", async () => {
    const body = await readBody(await POST(restoreRequest({ confirmation: null })));
    expect(body.error?.code).toBe("backup_confirmation_mismatch");
    // The body was never read, so a wrong request cannot be mistaken for a bad file.
    expect(mocks.restoreBackupJson).not.toHaveBeenCalled();
  });

  it("explains a missing preview checksum before it reads the body", async () => {
    const body = await readBody(await POST(restoreRequest({ checksum: null })));
    expect(body.error?.code).toBe("backup_preview_mismatch");
    expect(mocks.restoreBackupJson).not.toHaveBeenCalled();
  });

  it("carries a household name with an apostrophe or an accent through the header intact", async () => {
    // A real household is called something like "Dad & Mum's House". The confirmation is compared
    // against the household's own name, so a name mangled in transit reads as the wrong household.
    for (const name of ["Dad & Mum's House", "Küche & Löwen", "家族のおうち", "Smith-Jones Household"]) {
      mocks.restoreBackupJson.mockResolvedValueOnce({ ok: true });
      await POST(restoreRequest({ confirmation: name }));
      expect(mocks.restoreBackupJson).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ confirmation: name })
      );
    }
  });

  it("refuses a file sent with the wrong content type instead of guessing", async () => {
    const body = await readBody(await POST(restoreRequest({ contentType: "text/plain" })));
    expect(body.error?.code).toBe("backup_invalid_content_type");
    expect(body.error?.message).not.toMatch(/^backup_/);
  });

  it("tells the person their file is unreadable rather than blaming the server", async () => {
    const body = await readBody(await POST(restoreRequest({ body: "{ not json" })));
    expect(body.error?.code).toBe("backup_invalid_json");
  });

  it("sends an archive upload down the archive path, not the JSON path", async () => {
    // The User's real backup is a zip, because their household has photos. Windows browsers label it
    // application/x-zip-compressed, so both spellings must take the archive branch.
    for (const contentType of ["application/zip", "application/x-zip-compressed"]) {
      mocks.withUpload.mockImplementationOnce(async (_request: Request, work: (path: string) => Promise<unknown>) =>
        work("/staged/backup.zip")
      );
      mocks.restoreBackupArchive.mockResolvedValueOnce({ ok: true });
      await POST(restoreRequest({ contentType, body: "PK\u0003\u0004" }));
      expect(mocks.restoreBackupArchive).toHaveBeenCalledWith("/staged/backup.zip", expect.anything());
      expect(mocks.restoreBackupJson).not.toHaveBeenCalled();
    }
  });

  it("explains an unreadable archive with the code the archive path really produces", async () => {
    // Not `archive_invalid`: openBackupArchive catches the zip reader's own error and rethrows
    // `backup_invalid` (src/server/services/backup-archive.ts:123), so that is what a truncated or
    // unsupported zip actually reaches the route as. A photo whose bytes do not match the manifest
    // becomes `backup_photo_mismatch` (backup-archive.ts:151). Both are already mapped - asserted
    // here because the User's real backup IS a zip, so these are the archive errors they can meet.
    for (const code of ["backup_invalid", "backup_photo_mismatch"]) {
      mocks.withUpload.mockImplementationOnce(async (_r: Request, work: (p: string) => Promise<unknown>) => work("/s.zip"));
      mocks.restoreBackupArchive.mockRejectedValueOnce(new Error(code));
      const body = await readBody(await POST(restoreRequest({ contentType: "application/zip", body: "PK" })));
      expect(body.error?.code).toBe(code);
      expect(body.error?.message ?? "").not.toMatch(/^(backup|archive)_/);
    }
  });

  // A database failure during a restore is not a bare message - Prisma reports P2024 (no connection
  // available) and P2028 (transaction closed) on `code`, and these used to fall through to the
  // catch-all, telling the person "Something went wrong" with no way to know whether their data
  // arrived. They are now named and marked retryable, which is what they are.
  it("tells the person to retry when the database could not finish the restore", async () => {
    class PrismaKnownError extends Error {
      code: string;
      clientVersion = "6.x";
      constructor(code: string, message: string) {
        super(message);
        this.name = "PrismaClientKnownRequestError";
        this.code = code;
      }
    }

    const transient = [
      new PrismaKnownError("P2024", "Timed out fetching a new connection from the connection pool."),
      new PrismaKnownError("P2028", "Transaction already closed: Transaction api error."),
      new PrismaKnownError("P1017", "Server has closed the connection.")
    ];

    for (const failure of transient) {
      mocks.restoreBackupJson.mockRejectedValueOnce(failure);
      const response = await POST(restoreRequest());
      const body = await readBody(response);
      expect(response.status).toBe(503);
      expect(body.error?.code).toBe("database_unavailable");
      // The person must be told nothing was saved and that retrying is the next step.
      expect(body.error?.message).toMatch(/try again/i);
      expect(body.error?.message).not.toBe("Something went wrong.");
    }
  });

  it("still hides a genuine bug behind the generic failure, rather than inviting a pointless retry", async () => {
    // A trigger raise is a defect in the data or the code, not a transient condition. It arrives as
    // Prisma wrapper TEXT with no retryable code, so it must keep reaching the catch-all, where it is
    // logged for whoever maintains the server. Telling a family to "try again" here would loop them.
    mocks.restoreBackupJson.mockRejectedValueOnce(
      new Error('Invalid `prisma.$executeRaw()` invocation: raised exception: activity_timer_pause_integrity_failed')
    );
    const body = await readBody(await POST(restoreRequest()));
    expect(body.error?.code).toBe("server_error");

    // A unique-constraint violation is the same class: a bug, not a capacity problem.
    const conflict = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    mocks.restoreBackupJson.mockRejectedValueOnce(conflict);
    const second = await readBody(await POST(restoreRequest()));
    expect(second.error?.code).toBe("server_error");
  });
});
