import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  householdFindMany: vi.fn(),
  backupFindMany: vi.fn(),
  backupCreate: vi.fn(),
  backupUpdate: vi.fn(),
  babyCount: vi.fn(),
  contactCount: vi.fn(),
  catalogCount: vi.fn(),
  activityCount: vi.fn(),
  eventCount: vi.fn(),
  reminderCount: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  buildSnapshot: vi.fn(),
  publish: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
  reconcile: vi.fn(),
  scan: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    household: { findMany: mocks.householdFindMany },
    backupRecord: { findMany: mocks.backupFindMany, create: mocks.backupCreate, update: mocks.backupUpdate },
    baby: { count: mocks.babyCount },
    contact: { count: mocks.contactCount },
    medicineCatalog: { count: mocks.catalogCount },
    activityLog: { count: mocks.activityCount },
    calendarEvent: { count: mocks.eventCount },
    reminder: { count: mocks.reminderCount },
    $queryRaw: mocks.queryRaw,
    $transaction: mocks.transaction
  }
}));

vi.mock("@/server/services/backups", () => ({
  buildHouseholdV2Snapshot: mocks.buildSnapshot,
  summarizeBackupItemCount: vi.fn(() => 7)
}));

vi.mock("@/server/services/local-backup-storage", () => ({
  publishLocalBackup: mocks.publish,
  readLocalBackup: mocks.read,
  removeLocalBackup: mocks.remove,
  reconcileLocalBackupTemps: mocks.reconcile,
  scanLocalBackups: mocks.scan
}));

import {
  pruneAutomatedBackups,
  reconcileAutomatedBackupStorage,
  runAutomatedBackupIfDue,
  runAutomatedBackupScan
} from "@/server/services/automated-backups";

const config = {
  enabled: true,
  directory: "/var/lib/cubby/backups",
  intervalHours: 24,
  retentionCount: 30,
  pollMinutes: 15,
  retryMinutes: 60
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async (operation: (tx: unknown) => Promise<unknown>) =>
    operation({
      $queryRaw: mocks.queryRaw,
      backupRecord: { findMany: mocks.backupFindMany, create: mocks.backupCreate },
      baby: { count: mocks.babyCount },
      contact: { count: mocks.contactCount },
      medicineCatalog: { count: mocks.catalogCount },
      activityLog: { count: mocks.activityCount },
      calendarEvent: { count: mocks.eventCount },
      reminder: { count: mocks.reminderCount },
      household: {}
    })
  );
  mocks.queryRaw.mockResolvedValue([{ locked: true }]);
  mocks.backupFindMany.mockResolvedValue([]);
  mocks.backupCreate.mockResolvedValue({ id: "backup-record" });
  mocks.babyCount.mockResolvedValue(1);
  mocks.contactCount.mockResolvedValue(0);
  mocks.catalogCount.mockResolvedValue(0);
  mocks.activityCount.mockResolvedValue(0);
  mocks.eventCount.mockResolvedValue(0);
  mocks.reminderCount.mockResolvedValue(0);
  mocks.buildSnapshot.mockResolvedValue({ format: "cubby-household-backup", version: 2, exportedAt: "2026-07-15T21:50:13.000Z", payload: { household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: [] }, checksum: "a".repeat(64) });
  mocks.publish.mockResolvedValue({ filename: "backup.json", checksum: "a".repeat(64), exportedAt: "2026-07-15T21:50:13.000Z", householdName: "Home", size: 100, absolutePath: "x" });
  mocks.read.mockRejectedValue(new Error("backup_invalid"));
  mocks.remove.mockResolvedValue(undefined);
  mocks.scan.mockResolvedValue([]);
});

describe("automated backups", () => {
  it("skips all work when disabled", async () => {
    expect(await runAutomatedBackupIfDue("household-1", new Date("2026-07-15T22:00:00.000Z"), { ...config, enabled: false })).toEqual({ skipped: "disabled" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("records a complete automated export for a due household", async () => {
    const result = await runAutomatedBackupIfDue("household-1", new Date("2026-07-15T22:00:00.000Z"), config);

    expect(result).toEqual({ completed: true, filename: "backup.json" });
    expect(mocks.buildSnapshot).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.backupCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        householdId: "household-1",
        actorUserId: null,
        kind: "automated_export",
        status: "complete",
        storageFilename: "backup.json",
        byteSize: 100
      })
    }));
  });

  it("uses distinct stable filename namespaces for identical household snapshots", async () => {
    const now = new Date("2026-07-15T22:00:00.000Z");

    await expect(runAutomatedBackupIfDue("household-1", now, config)).resolves.toMatchObject({ completed: true });
    await expect(runAutomatedBackupIfDue("household-2", now, config)).resolves.toMatchObject({ completed: true });

    const firstOptions = mocks.publish.mock.calls[0]?.[2];
    const secondOptions = mocks.publish.mock.calls[1]?.[2];
    expect(firstOptions?.filenameDiscriminator).toMatch(/^[a-f0-9]{32}$/);
    expect(secondOptions?.filenameDiscriminator).toMatch(/^[a-f0-9]{32}$/);
    expect(firstOptions?.filenameDiscriminator).not.toBe(secondOptions?.filenameDiscriminator);
  });

  it("prunes by exact stored filename when unchanged versions share one checksum", async () => {
    const checksum = "a".repeat(64);
    const exportedAtByFilename = new Map([
      ["new.json", "2026-07-15T00:00:00.000Z"],
      ["middle.json", "2026-07-14T00:00:00.000Z"],
      ["old.json", "2026-07-13T00:00:00.000Z"]
    ]);
    mocks.read.mockImplementation(async (_directory: string, filename: string) => ({
      filename,
      checksum,
      exportedAt: exportedAtByFilename.get(filename)
    }));
    mocks.backupFindMany.mockResolvedValue([
      { id: "new-record", checksum, storageFilename: "new.json" },
      { id: "middle-record", checksum, storageFilename: "middle.json" },
      { id: "old-record", checksum, storageFilename: "old.json" }
    ]);

    await pruneAutomatedBackups({ ...config, retentionCount: 2 }, "household-1");

    expect(mocks.remove).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledWith(config.directory, "old.json");
    expect(mocks.backupUpdate).toHaveBeenCalledWith({
      where: { id: "old-record" },
      data: { status: "pruned" }
    });
    expect(mocks.scan).not.toHaveBeenCalled();
  });

  it("keeps a newly published backup when the retention metadata query fails", async () => {
    mocks.backupFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("database_unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      runAutomatedBackupIfDue("household-1", new Date("2026-07-15T22:00:00.000Z"), config)
    ).resolves.toEqual({ completed: true, filename: "backup.json" });

    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.backupCreate).toHaveBeenCalledTimes(2);
    expect(mocks.backupCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        householdId: "household-1",
        kind: "automated_export",
        status: "failed",
        error: "backup_retention_failed"
      })
    });
    expect(error).toHaveBeenCalledWith("backup_retention_failed", "backup_retention_failed");
  });

  it("records a sanitized failure and no success file when publication fails", async () => {
    mocks.publish.mockRejectedValue(new Error("backup_directory_unavailable"));

    const result = await runAutomatedBackupIfDue("household-1", new Date("2026-07-15T22:00:00.000Z"), config);

    expect(result).toEqual({ failed: true, error: "backup_directory_unavailable" });
    expect(mocks.backupCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "failed", error: "backup_directory_unavailable" })
    }));
  });

  it("retries an hour after a failure newer than a recent success", async () => {
    mocks.backupFindMany.mockResolvedValue([
      {
        id: "failure",
        createdAt: new Date("2026-07-15T20:59:00.000Z"),
        checksum: null,
        status: "failed",
        error: "backup_active_timer"
      },
      {
        id: "success",
        createdAt: new Date("2026-07-15T20:00:00.000Z"),
        checksum: "a".repeat(64),
        status: "complete",
        error: null
      }
    ]);

    await expect(
      runAutomatedBackupIfDue("household-1", new Date("2026-07-15T22:00:00.000Z"), config)
    ).resolves.toEqual({ completed: true, filename: "backup.json" });
  });

  it("does not let an older failure suppress a newer successful schedule", async () => {
    mocks.backupFindMany.mockResolvedValue([
      {
        id: "success",
        createdAt: new Date("2026-07-15T21:30:00.000Z"),
        checksum: "a".repeat(64),
        status: "complete",
        error: null
      },
      {
        id: "failure",
        createdAt: new Date("2026-07-15T21:00:00.000Z"),
        checksum: null,
        status: "failed",
        error: "backup_active_timer"
      }
    ]);

    await expect(
      runAutomatedBackupIfDue("household-1", new Date("2026-07-15T22:00:00.000Z"), config)
    ).resolves.toEqual({ skipped: "not_due" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("reconciles storage and scans households once", async () => {
    mocks.householdFindMany.mockResolvedValue([{ id: "household-1" }, { id: "household-2" }]);

    await reconcileAutomatedBackupStorage(config);
    const result = await runAutomatedBackupScan(new Date("2026-07-15T22:00:00.000Z"), config);

    expect(mocks.reconcile).toHaveBeenCalledWith("/var/lib/cubby/backups");
    expect(result).toEqual({ scanned: 2 });
  });

  it("continues later households and sanitizes logs when one preflight query fails", async () => {
    mocks.householdFindMany.mockResolvedValue([{ id: "household-1" }, { id: "household-2" }]);
    mocks.backupFindMany
      .mockRejectedValueOnce(new Error("database failed at C:\\secret\\households"))
      .mockResolvedValue([]);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runAutomatedBackupScan(new Date("2026-07-15T22:00:00.000Z"), config)).resolves.toEqual({ scanned: 2 });

    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("backup_household_scan_failed", "backup_write_failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret");
  });

  it("directly verifies a linked file omitted by the bounded scan", async () => {
    const checksum = "a".repeat(64);
    mocks.backupFindMany.mockResolvedValue([
      { id: "beyond-scan", checksum, storageFilename: "beyond-scan.json" }
    ]);
    mocks.scan.mockResolvedValue([]);
    mocks.read.mockResolvedValue({
      healthy: true,
      filename: "beyond-scan.json",
      checksum,
      exportedAt: "2026-07-15T00:00:00.000Z"
    });

    await reconcileAutomatedBackupStorage(config);

    expect(mocks.backupUpdate).not.toHaveBeenCalled();
  });

  it("marks linked complete records failed when files are missing or corrupt", async () => {
    mocks.backupFindMany.mockResolvedValue([
      { id: "missing-record", checksum: "a".repeat(64), storageFilename: "missing.json" },
      { id: "corrupt-record", checksum: "b".repeat(64), storageFilename: "corrupt.json" }
    ]);
    mocks.scan.mockResolvedValue([
      { healthy: false, filename: "corrupt.json", errorCode: "backup_invalid" }
    ]);

    await reconcileAutomatedBackupStorage(config);

    expect(mocks.backupUpdate).toHaveBeenCalledWith({
      where: { id: "missing-record" },
      data: { status: "failed", error: "backup_file_missing" }
    });
    expect(mocks.backupUpdate).toHaveBeenCalledWith({
      where: { id: "corrupt-record" },
      data: { status: "failed", error: "backup_invalid" }
    });
  });
});
