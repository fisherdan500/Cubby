import { describe, expect, it, vi } from "vitest";
import { handleError } from "./http";

describe("handleError", () => {
  it("returns a safe conflict response for a stale mutation revision", async () => {
    const response = handleError(new Error("stale_revision"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "stale_revision",
        message: "This item changed before your request completed. Refresh and try again."
      }
    });
  });

  it.each([
    ["household_selection_required", "Select a household to continue."],
    ["household_selection_stale", "Your selected household is no longer available. Choose another household."]
  ] as const)("returns an explicit conflict response for %s", async (code, message) => {
    const response = handleError(new Error(code));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code, message }
    });
  });

  it("tells the person Cubby cannot reach its backup folder, rather than blaming their file", async () => {
    // local-backup-storage raises this when the backup root is missing, is a symlink, or changed
    // identity, and sanitizeReadError passes it through verbatim rather than collapsing it to
    // backup_invalid - so it arrives here intact from GET /api/backups/local/[filename]. It is a
    // server-side configuration fault, which is why it is a 503 and why the wording points at the
    // server: a new machine with a mis-provisioned backup directory is the likeliest way to meet it,
    // and telling a family their backup is corrupt in that moment would send them looking in the
    // wrong place.
    const response = handleError(new Error("backup_directory_unavailable"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "backup_directory_unavailable",
        message: "Cubby cannot reach its backup folder (AUTOMATED_BACKUP_DIRECTORY). Check it on the platform page, then try again."
      }
    });
  });

  it("names a transient database failure and invites a retry, instead of a blank 500", async () => {
    // Prisma puts these on `code`, not in `message`, so the string chain below cannot see them and
    // they used to reach the catch-all. A long restore holds one serializable transaction across
    // thousands of rows, which is exactly where an exhausted pool or a closed transaction shows up.
    for (const code of ["P2024", "P2028", "P2034", "P1001", "P1002", "P1008", "P1017"]) {
      const response = handleError(Object.assign(new Error("prisma failure"), { code }));
      const body = (await response.json()) as { error: { code: string; message: string } };

      expect(response.status).toBe(503);
      expect(body.error.code).toBe("database_unavailable");
      expect(body.error.message).toMatch(/try again/i);
    }
  });

  it("keeps a database bug behind the generic failure, so nobody is told to retry a defect", async () => {
    // P2002 is a unique-constraint violation and P2025 a missing record: both mean the code or the
    // data is wrong, and retrying repeats the failure. They must stay in the logged catch-all.
    for (const code of ["P2002", "P2025", "P2003"]) {
      const response = handleError(Object.assign(new Error("prisma failure"), { code }));
      const body = (await response.json()) as { error: { code: string } };

      expect(response.status).toBe(500);
      expect(body.error.code).toBe("server_error");
    }
  });

  it("gives a readable sentence for every backup failure a person can reach", async () => {
    // The mapping table guarded where it lives. The route test proves the restore endpoint reaches
    // these; this proves handleError itself translates them, so a deleted branch fails here too.
    // Each entry carries its status, so a branch silently restatused is caught as well as a deleted
    // one - a 422 quietly becoming a 500 would change nothing visible in the message alone.
    const expected: Array<[string, number]> = [
      ["backup_invalid", 422],
      ["backup_invalid_json", 422],
      ["backup_invalid_content_type", 415],
      ["backup_too_large", 413],
      ["backup_checksum_mismatch", 422],
      ["backup_unsupported_version", 422],
      ["backup_target_not_empty", 409],
      ["backup_active_timer", 409],
      ["backup_invalid_timer", 422],
      ["backup_invalid_pause_intervals", 422],
      ["pause_interval_state_invalid", 422],
      ["backup_duplicate_source_id", 422],
      ["backup_dangling_reference", 422],
      ["backup_photo_unavailable", 409],
      ["backup_photo_mismatch", 422],
      ["backup_photos_missing", 422],
      ["backup_confirmation_mismatch", 422],
      ["backup_preview_mismatch", 409],
      ["backup_audit_integrity_unavailable", 409],
      ["backup_restore_retry", 409],
      ["backup_upload_busy", 429],
      ["backup_upload_timeout", 408],
      ["backup_upload_aborted", 408],
      ["backup_directory_unavailable", 503],
      ["archive_too_large", 413]
    ];

    const unexplained: string[] = [];
    const wrongStatus: string[] = [];
    for (const [code, status] of expected) {
      const response = handleError(new Error(code));
      const body = (await response.json()) as { error: { code: string; message: string } };
      if (body.error.code === "server_error") unexplained.push(code);
      if (response.status !== status) wrongStatus.push(`${code}:${response.status}!=${status}`);
      // A raw identifier in the interface is not an explanation.
      expect(body.error.message).not.toMatch(/^(backup|archive|pause)_/);
    }
    expect(unexplained).toEqual([]);
    expect(wrongStatus).toEqual([]);
  });

  it("tells a family what to do when the household they are restoring into already has data", async () => {
    // The commonest moment to reach for a backup is on the instance already in use, and the refusal
    // there used to name the requirement ("a fresh household with only its current owner") without
    // naming a way forward. Pin the guidance: the message has to offer the paths that work, or this
    // regresses to a dead end the next time someone edits the copy.
    const response = handleError(new Error("backup_target_not_empty"));
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("backup_target_not_empty");
    expect(body.error.message).toMatch(/already has data/i);
    expect(body.error.message).toMatch(/new empty household/i);
    // Says why it refuses rather than only that it refuses.
    expect(body.error.message).toMatch(/overwrite/i);
  });

  it("falls back to a generic failure for an error it does not recognise", async () => {
    // Still the right behaviour for a genuinely unknown error: say little, log everything. A database
    // trigger raise arrives as Prisma wrapper text with no retryable code and belongs here.
    const logged: unknown[][] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const response = handleError(
      new Error('Invalid `prisma.$executeRaw()` invocation: raised exception: some_trigger_failed')
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("server_error");

    // The cause stays hidden, but the occurrence is quotable.
    expect(body.error.message).not.toContain("some_trigger_failed");
    expect(body.error.message).not.toContain("prisma");
    const reference = body.error.message.match(/reference ([0-9A-F]{8})\./)?.[1];
    expect(reference, "the generic failure must carry a quotable reference").toBeTruthy();

    // ... and the SAME reference is on the logged line, so one grep joins the two. Without this the
    // operator has only a timestamp to go on, which is what made a real restore failure undebuggable.
    expect(logged).toHaveLength(1);
    expect(String(logged[0][0])).toBe(`[cubby-failure ${reference}]`);
    expect(logged[0][1]).toBeInstanceOf(Error);
    expect(String((logged[0][1] as Error).message)).toContain("some_trigger_failed");

    consoleError.mockRestore();
  });

  it("gives each unrecognised failure its own reference", async () => {
    // Derived (hashed) references would collide across occurrences, making two separate failures
    // indistinguishable in the log.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await (handleError(new Error("one_unknown_thing"))).json();
    const second = await (handleError(new Error("one_unknown_thing"))).json();

    const a = first.error.message.match(/reference ([0-9A-F]{8})\./)?.[1];
    const b = second.error.message.match(/reference ([0-9A-F]{8})\./)?.[1];
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);

    consoleError.mockRestore();
  });
});
