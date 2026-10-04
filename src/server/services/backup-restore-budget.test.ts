/**
 * How long a restore is allowed to take, and what happens past that.
 *
 * A fixed transaction budget silently failed any household with more than roughly 1,400 entries: the
 * restore ran for two minutes, exhausted its transaction and rolled back, which reached the person as
 * a failed migration with nothing to act on. The budget is now derived from the payload, so these
 * cases pin the shape of that derivation rather than any one number.
 */
import { describe, expect, it } from "vitest";
import {
  archiveRestoreRecordCount,
  RESTORE_UNITS_PER_ARCHIVE_PHOTO,
  restoreTimeoutForRecords
} from "@/server/services/backups";

describe("what a restore is charged for", () => {
  it("charges a photo for the work it does inside the transaction", () => {
    // Each photo costs an intent lock, a byte read back and an ownership transfer inside the
    // transaction, on top of the attachment row the payload already carries. Billing fewer than that
    // is how a photo-heavy household would run out of budget partway.
    expect(RESTORE_UNITS_PER_ARCHIVE_PHOTO).toBe(3);

    const payload = { activities: Array(10).fill(null), feedPhotos: Array(4).fill(null) };
    const withoutPhotos = archiveRestoreRecordCount(payload, 0);
    const withPhotos = archiveRestoreRecordCount(payload, 4);

    expect(withPhotos - withoutPhotos).toBe(4 * RESTORE_UNITS_PER_ARCHIVE_PHOTO);
  });

  it("counts every collection the restore writes row by row", () => {
    // Each of these is inserted one row at a time inside the transaction, so each has to be paid for.
    // notificationPreferences is the one that was missed: the format allows a thousand of them.
    const collections = [
      "activities", "babies", "feedPosts", "feedComments", "feedReactions",
      "calendarEvents", "reminders", "contacts", "catalogs", "plannedSchedules",
      "feedPhotos", "notificationPreferences"
    ];

    const uncounted = collections.filter((name) => {
      const empty = archiveRestoreRecordCount({}, 0);
      const populated = archiveRestoreRecordCount({ [name]: Array(5).fill(null) } as never, 0);
      return populated - empty !== 5;
    });

    expect(uncounted).toEqual([]);
  });
});

describe("the budget a restore is given", () => {
  it("never drops below the floor, however small the household", () => {
    // A brand-new household restoring a nearly-empty backup must not be held to a few milliseconds.
    for (const records of [0, 1, 10, 100]) {
      const budget = restoreTimeoutForRecords(records);
      expect(budget.timeoutMs).toBe(120_000);
      expect(budget.exceedsCeiling).toBe(false);
    }
  });

  it("grows with the household, so more history means more time rather than failure", () => {
    // The defect this replaced: 3,273 entries needed about 75 seconds of work and were given a flat
    // 120-second budget that the rest of the restore then ate into. The budget must now track size.
    const small = restoreTimeoutForRecords(500);
    const real = restoreTimeoutForRecords(3_307);
    const large = restoreTimeoutForRecords(20_000);

    expect(real.timeoutMs).toBeGreaterThan(small.timeoutMs);
    expect(large.timeoutMs).toBeGreaterThan(real.timeoutMs);
    // A household of the size that used to fail now gets several times the measured cost of its own
    // restore, which is the margin that makes it survivable on slower hardware.
    expect(real.timeoutMs).toBeGreaterThan(400_000);
  });

  it("scales in proportion, not in steps", () => {
    // Twice the history, twice the budget: a stepped or capped curve would reintroduce a cliff at
    // whichever size the steps ran out, which is the failure mode being removed.
    const single = restoreTimeoutForRecords(4_000).timeoutMs;
    const double = restoreTimeoutForRecords(8_000).timeoutMs;
    expect(double).toBe(single * 2);
  });

  it("refuses a payload it could not finish, rather than accepting one it will abandon", () => {
    // The ceiling is a real limit and it must announce itself up front. A restore that is accepted and
    // then abandoned partway is the worst outcome: the person waits, and then has nothing.
    const beyond = restoreTimeoutForRecords(200_000);
    expect(beyond.exceedsCeiling).toBe(true);
    // Even when refused, the reported budget stays bounded - nothing downstream should see a timeout
    // of arbitrary size.
    expect(beyond.timeoutMs).toBe(21_600_000);
  });

  it("admits far more history than a household can plausibly accumulate", () => {
    // 144,000 records is on the order of forty years of heavy daily tracking. The limit exists to keep
    // a transaction bounded, not to ration ordinary use, so a realistic household must sit well inside
    // it - including one several times larger than the one that exposed the original defect.
    expect(restoreTimeoutForRecords(3_307).exceedsCeiling).toBe(false);
    expect(restoreTimeoutForRecords(50_000).exceedsCeiling).toBe(false);
    expect(restoreTimeoutForRecords(144_000).exceedsCeiling).toBe(false);
  });
});
