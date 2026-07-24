import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  householdFind: vi.fn(),
  householdCount: vi.fn(),
  householdUpdate: vi.fn(),
  settingsFind: vi.fn(),
  settingsUpsert: vi.fn(),
  babyFindMany: vi.fn(),
  babyFindFirst: vi.fn(),
  babyCreate: vi.fn(),
  babyUpdate: vi.fn(),
  activityFindMany: vi.fn(),
  activityFindFirst: vi.fn(),
  contactFindMany: vi.fn(),
  contactCreate: vi.fn(),
  catalogFindMany: vi.fn(),
  catalogCreate: vi.fn(),
  calendarFindMany: vi.fn(),
  calendarCreate: vi.fn(),
  reminderFindMany: vi.fn(),
  reminderCreate: vi.fn(),
  backupCreate: vi.fn(),
  backupFindMany: vi.fn(),
  backupFindFirst: vi.fn(),
  backupCount: vi.fn(),
  restoreActivity: vi.fn(),
  transaction: vi.fn(),
  lockActor: vi.fn(),
  lockBaby: vi.fn(),
  writeAudit: vi.fn(),
  memberCreate: vi.fn(),
  memberUpdate: vi.fn(),
  memberUpdateMany: vi.fn(),
  memberDelete: vi.fn(),
  memberDeleteMany: vi.fn(),
  freshState: vi.fn(),
  isLocalBackupFilename: vi.fn(),
  scanLocalBackups: vi.fn(),
  readLocalBackup: vi.fn(),
  readLocalBackupDocument: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    household: {
      findUniqueOrThrow: mocks.householdFind,
      update: mocks.householdUpdate,
      count: mocks.householdCount
    },
    householdSettings: { findUnique: mocks.settingsFind, upsert: mocks.settingsUpsert },
    baby: {
      findMany: mocks.babyFindMany,
      findFirst: mocks.babyFindFirst,
      create: mocks.babyCreate,
      update: mocks.babyUpdate
    },
    activityLog: { findMany: mocks.activityFindMany, findFirst: mocks.activityFindFirst },
    contact: { findMany: mocks.contactFindMany, create: mocks.contactCreate },
    medicineCatalog: { findMany: mocks.catalogFindMany, create: mocks.catalogCreate },
    calendarEvent: { findMany: mocks.calendarFindMany, create: mocks.calendarCreate },
    reminder: { findMany: mocks.reminderFindMany, create: mocks.reminderCreate },
    backupRecord: {
      create: mocks.backupCreate,
      findMany: mocks.backupFindMany,
      findFirst: mocks.backupFindFirst,
      count: mocks.backupCount
    },
    $queryRaw: mocks.freshState,
    $transaction: mocks.transaction,
    householdMember: {
      create: mocks.memberCreate,
      update: mocks.memberUpdate,
      updateMany: mocks.memberUpdateMany,
      delete: mocks.memberDelete,
      deleteMany: mocks.memberDeleteMany
    }
  }
}));

vi.mock("@/server/auth/context", () => ({
  getHouseholdContext: mocks.getHouseholdContext,
  requirePermission: mocks.requirePermission
}));

vi.mock("@/server/services/activities", () => ({
  activityInclude: {},
  restoreHistoricalActivityForContext: mocks.restoreActivity
}));

vi.mock("@/server/services/mutation-locks", () => ({
  lockActorForWrite: mocks.lockActor,
  lockBabyForWrite: mocks.lockBaby
}));

vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/server/services/local-backup-storage", () => ({
  isLocalBackupFilename: mocks.isLocalBackupFilename,
  scanLocalBackups: mocks.scanLocalBackups,
  readLocalBackup: mocks.readLocalBackup,
  readLocalBackupDocument: mocks.readLocalBackupDocument
}));

import {
  buildHouseholdV2Snapshot,
  downloadLocalBackupFile,
  exportBackupJson,
  exportHouseholdBackupJson,
  getAutomatedBackupStatus,
  previewBackupJson,
  restoreBackupJson
} from "@/server/services/backups";
import { createV2Backup } from "@/server/services/backup-format";

const ctx = {
  userId: "user-1",
  householdId: "household-1",
  memberId: "member-1",
  role: "owner"
};

const unitPreferences = {
  volume: "mL",
  weight: "kg",
  length: "cm",
  temperature: "C",
  medicineUnits: { Acetaminophen: "mL" },
  supplementUnits: { "Vitamin D": "drops" }
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getHouseholdContext.mockResolvedValue(ctx);
  mocks.householdFind.mockResolvedValue({ id: "household-1", name: "Home" });
  mocks.householdCount.mockResolvedValue(1);
  mocks.backupCount.mockResolvedValue(0);
  mocks.backupFindFirst.mockResolvedValue(null);
  mocks.isLocalBackupFilename.mockReturnValue(true);
  mocks.settingsFind.mockResolvedValue({ accentTheme: "sage", unitPreferences });
  mocks.babyFindMany.mockResolvedValue([]);
  mocks.babyFindFirst.mockResolvedValue(null);
  mocks.babyCreate.mockResolvedValue(null);
  mocks.babyUpdate.mockResolvedValue(null);
  mocks.restoreActivity.mockResolvedValue({ id: "activity-restored" });
  mocks.transaction.mockImplementation((operation) => operation(transactionClient()));
  mocks.lockActor.mockResolvedValue(ctx);
  mocks.lockBaby.mockImplementation(async (_tx, _ctx, id) => ({ id, inactiveAt: null }));
  mocks.activityFindMany.mockResolvedValue([]);
  mocks.activityFindFirst.mockResolvedValue(null);
  mocks.contactFindMany.mockResolvedValue([]);
  mocks.catalogFindMany.mockResolvedValue([]);
  mocks.calendarFindMany.mockResolvedValue([]);
  mocks.reminderFindMany.mockResolvedValue([]);
  mocks.backupCreate.mockResolvedValue({ id: "backup-1" });
  mocks.backupFindMany.mockResolvedValue([]);
  mocks.settingsUpsert.mockResolvedValue({});
  mocks.householdUpdate.mockResolvedValue({ id: "household-1", name: "Recovered Home" });
  mocks.contactCreate.mockResolvedValue({ id: "saved-contact-1" });
  mocks.catalogCreate.mockResolvedValue({ id: "saved-catalog-1" });
  mocks.calendarCreate.mockResolvedValue({ id: "saved-event-1" });
  mocks.reminderCreate.mockResolvedValue({ id: "saved-reminder-1" });
  mocks.freshState.mockResolvedValue([{ actorIsSoleOwner: true, operationalCount: 0n }]);
  mocks.scanLocalBackups.mockResolvedValue([]);
  mocks.readLocalBackup.mockRejectedValue(new Error("backup_invalid"));
  mocks.readLocalBackupDocument.mockResolvedValue({
    file: { filename: "backup.json", checksum: "a".repeat(64) },
    body: Buffer.from("{}")
  });
});

describe("backup unit preferences", () => {
  it("previews a valid backup without writes and rejects a populated target", async () => {
    const backup = createV2Backup({
      household: { name: "Recovered Home" }, settings: {}, babies: [], contacts: [], catalogs: [],
      activities: [], calendarEvents: [], reminders: []
    }, "2026-07-15T18:00:00.000Z");

    await expect(previewBackupJson(backup)).resolves.toMatchObject({
      householdName: "Recovered Home", legacyPartial: false, checksumVerified: true,
      counts: { babies: 0, activities: 0 }
    });
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "backup.manage");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.backupCreate).not.toHaveBeenCalled();

    mocks.freshState.mockResolvedValue([{ actorIsSoleOwner: true, operationalCount: 1n }]);
    await expect(previewBackupJson(backup)).rejects.toThrow("backup_target_not_empty");
  });

  it("labels malformed v2 and legacy backup schemas as backup-specific invalid files", async () => {
    await expect(previewBackupJson({
      format: "cubby-household-backup",
      version: 2,
      exportedAt: "not-a-date",
      payload: {},
      checksum: "0".repeat(64)
    })).rejects.toThrow("backup_invalid");

    const malformedLegacy = {
      version: 1,
      babies: [{ id: "source-baby", timezone: "UTC" }],
      activities: []
    };
    await expect(previewBackupJson(malformedLegacy)).rejects.toThrow("backup_invalid");
    await expect(restoreBackupJson(malformedLegacy)).rejects.toThrow("backup_invalid");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rechecks target emptiness inside the serializable restore transaction", async () => {
    mocks.freshState.mockResolvedValue([{ actorIsSoleOwner: true, operationalCount: 1n }]);

    await expect(restoreBackupJson({ version: 1, babies: [], activities: [] })).rejects.toThrow("backup_target_not_empty");

    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.backupCreate).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
  });

  it("restores a complete v2 snapshot with mapped relationships and one recovery audit", async () => {
    mocks.babyCreate.mockResolvedValue({ id: "saved-baby-1", name: "Finley", inactiveAt: null });
    mocks.babyUpdate.mockResolvedValue({ id: "saved-baby-1", name: "Finley", inactiveAt: new Date("2026-07-14T12:00:00.000Z") });
    const backup = createV2Backup({
      household: { name: "Recovered Home" },
      settings: { accentTheme: "rose", activityOrder: ["sleep", "feeding"] },
      babies: [{
        id: "source-baby-1", name: "Finley", birthDate: null, timezone: "UTC", notes: null,
        feedingWarningMinutes: 120, diaperWarningMinutes: null, sleepWarningMinutes: null,
        preferredUnits: null, inactiveAt: "2026-07-14T12:00:00.000Z"
      }],
      contacts: [{ id: "source-contact-1", name: "Doctor", kind: "pediatrician", phone: null, email: null, address: null, notes: null }],
      catalogs: [{ id: "source-catalog-1", name: "Vitamin D", typicalDoseSize: "1.5", unit: "drops", doseMinTime: null, notes: null, active: true, isSupplement: true }],
      activities: [{
        id: "source-activity-1", babyId: "source-baby-1", type: "medicine",
        occurredAt: "2026-07-14T10:00:00.000Z", startedAt: null, endedAt: null,
        timezone: "UTC", notes: "History", source: "sprout", externalActorName: "Grandma",
        timerState: "none", durationSeconds: null, pausedAt: null, pausedSeconds: 0,
        contactId: "source-contact-1", detail: { name: "Vitamin D", dose: "1.5", unit: "drops" }
      }],
      calendarEvents: [{
        id: "source-event-1", title: "Visit", description: null, startTime: "2026-07-15T18:00:00.000Z",
        endTime: null, allDay: false, eventType: "appointment", location: null, color: null,
        recurring: false, recurrencePattern: null, recurrenceEnd: null, customRecurrence: null,
        reminderMinutes: 30, source: "manual", externalCaretakerNames: [],
        babyIds: ["source-baby-1"], contactIds: ["source-contact-1"]
      }],
      reminders: [{ id: "source-reminder-1", babyId: "source-baby-1", kind: "medicine", title: "Dose", cadenceMinutes: 480, dueAt: null, enabled: true }]
    }, "2026-07-15T18:00:00.000Z");

    await expect(restoreBackupJson(backup, { confirmation: "Home", previewChecksum: backup.checksum })).resolves.toMatchObject({
      restored: 6,
      counts: { babies: 1, contacts: 1, catalogs: 1, activities: 1, calendarEvents: 1, reminders: 1 }
    });

    expect(mocks.householdUpdate).toHaveBeenCalledWith({ where: { id: "household-1" }, data: { name: "Recovered Home" } });
    expect(mocks.restoreActivity).toHaveBeenCalledWith(
      expect.objectContaining({ babyId: "saved-baby-1", contactId: "saved-contact-1", type: "medicine" }),
      ctx,
      expect.anything(),
      undefined,
      { source: "sprout", externalActorName: "Grandma" },
      { startedAt: null, endedAt: null, timezone: "UTC" }
    );
    expect(mocks.calendarCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        babies: { create: [{ babyId: "saved-baby-1" }] },
        contacts: { create: [{ contactId: "saved-contact-1" }] }
      })
    }));
    expect(mocks.reminderCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ babyId: "saved-baby-1" }) }));
    expect(mocks.restoreActivity.mock.invocationCallOrder[0]).toBeLessThan(mocks.babyUpdate.mock.invocationCallOrder[0]);
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "backup.restore" }), expect.anything());
    expect(mocks.backupCreate).toHaveBeenCalledTimes(1);
    expect(mocks.backupCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ itemCount: 6 }) })
    );
  });

  it("exports a complete v2 snapshot from one repeatable-read transaction", async () => {
    mocks.contactFindMany.mockResolvedValue([{ id: "contact-1", name: "Doctor", kind: null, phone: null, email: null, address: null, notes: null }]);
    mocks.catalogFindMany.mockResolvedValue([{ id: "catalog-1", name: "Vitamin D", typicalDoseSize: "1", unit: "drop", doseMinTime: null, notes: null, active: true, isSupplement: true }]);
    mocks.calendarFindMany.mockResolvedValue([{ id: "event-1", title: "Visit", description: null, startTime: new Date("2026-07-15T18:00:00.000Z"), endTime: null, allDay: false, eventType: null, location: null, color: null, recurring: false, recurrencePattern: null, recurrenceEnd: null, customRecurrence: null, reminderMinutes: null, source: "manual", externalCaretakerNames: [], babies: [], contacts: [] }]);
    mocks.reminderFindMany.mockResolvedValue([]);

    const payload = JSON.parse(await exportBackupJson());

    expect(payload).toMatchObject({ format: "cubby-household-backup", version: 2, payload: { household: { name: "Home" } } });
    expect(payload.payload.contacts).toHaveLength(1);
    expect(payload.payload.catalogs).toHaveLength(1);
    expect(payload.payload.calendarEvents).toHaveLength(1);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "RepeatableRead" }));
    expect(mocks.householdFind).toHaveBeenCalledOnce();
    expect(mocks.backupCreate.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.transaction.mock.invocationCallOrder[0]);
  });

  it("builds the same canonical v2 payload for internal and manual export paths", async () => {
    mocks.contactFindMany.mockResolvedValue([{ id: "contact-1", name: "Doctor", kind: null, phone: null, email: null, address: null, notes: null }]);

    const manual = JSON.parse(await exportBackupJson());
    const internal = await exportHouseholdBackupJson("household-1");
    const direct = await buildHouseholdV2Snapshot(
      transactionClient() as unknown as Parameters<typeof buildHouseholdV2Snapshot>[0],
      "household-1",
      internal.exportedAt
    );

    expect(internal).toEqual(direct);
    expect(internal.payload).toEqual(manual.payload);
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "backup.manage");
  });

  it("exports canonical household unit preferences", async () => {
    const payload = JSON.parse(await exportBackupJson());

    expect(payload.payload.settings.unitPreferences).toEqual(unitPreferences);
    expect(payload).not.toHaveProperty("members");
    expect(payload.payload.household).not.toHaveProperty("members");
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "backup.manage");
  });

  it("reports automated backup status from records and local discovery without exposing storage paths", async () => {
    const failureRecord = {
      id: "record-failed",
      createdAt: new Date("2026-07-15T21:30:00.000Z"),
      status: "failed",
      error: "backup_active_timer",
      checksum: null,
      itemCount: null,
      storageFilename: null
    };
    const successRecord = {
      id: "record-success",
      createdAt: new Date("2026-07-14T20:00:00.000Z"),
      status: "complete",
      error: null,
      checksum: "a".repeat(64),
      itemCount: 7,
      storageFilename: "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json"
    };
    mocks.backupFindFirst.mockResolvedValueOnce(successRecord).mockResolvedValueOnce(failureRecord);
    mocks.backupFindMany.mockResolvedValue([successRecord]);
    mocks.scanLocalBackups.mockResolvedValue([
      {
        healthy: true,
        filename: "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json",
        exportedAt: "2026-07-14T20:00:00.000Z",
        householdName: "Recovered Home",
        checksum: "a".repeat(64),
        size: 1234,
        itemCount: 7,
        absolutePath: "C:\\secret\\path.json"
      },
      { healthy: false, filename: "cubby-backup-v2-20260713T200000Z-bbbbbbbbbbbb.json", errorCode: "backup_invalid" }
    ]);

    const status = await getAutomatedBackupStatus();

    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "backup.manage");
    expect(status.config).toEqual({
      enabled: false,
      intervalHours: 24,
      retentionCount: 30,
      pollMinutes: 15,
      retryMinutes: 60
    });
    expect(status.latestSuccess).toEqual({
      createdAt: "2026-07-14T20:00:00.000Z",
      checksum: "a".repeat(64),
      itemCount: 7
    });
    expect(status.latestFailure).toEqual({
      createdAt: "2026-07-15T21:30:00.000Z",
      errorCode: "backup_active_timer"
    });
    expect(status.healthyVersionCount).toBe(1);
    expect(JSON.stringify(status)).not.toContain("C:\\secret\\path.json");
    expect(status.versions).toContainEqual({
      healthy: true,
      filename: "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json",
      exportedAt: "2026-07-14T20:00:00.000Z",
      householdName: "Recovered Home",
      checksum: "a".repeat(64),
      size: 1234,
      itemCount: 7
    });
    expect(mocks.backupFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "complete", storageFilename: { not: null } })
    }));
    expect(mocks.backupFindMany.mock.calls[0]?.[0]).not.toHaveProperty("take");
    expect(mocks.scanLocalBackups).toHaveBeenCalledWith(
      "/var/lib/cubby/backups",
      ["cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json"]
    );
  });

  it("reports a sanitized warning instead of failing Settings when the backup root is unavailable", async () => {
    mocks.scanLocalBackups.mockRejectedValue(new Error("EACCES C:\\private\\backup-root"));

    const status = await getAutomatedBackupStatus();

    expect(status.healthyVersionCount).toBe(0);
    expect(status.warnings).toEqual([{
      filename: "local backup directory",
      errorCode: "backup_directory_unavailable"
    }]);
    expect(JSON.stringify(status)).not.toContain("private");
  });

  it("reports a linked complete record whose local file is missing", async () => {
    const filename = "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json";
    mocks.backupFindMany.mockResolvedValue([{
      id: "record-success",
      createdAt: new Date("2026-07-14T20:00:00.000Z"),
      status: "complete",
      error: null,
      checksum: "a".repeat(64),
      itemCount: 7,
      storageFilename: filename
    }]);

    const status = await getAutomatedBackupStatus();

    expect(mocks.readLocalBackup).toHaveBeenCalledWith("/var/lib/cubby/backups", filename);
    expect(status.warnings).toContainEqual({ filename, errorCode: "backup_file_missing" });
  });

  it("downloads an existing local backup only through the protected service boundary", async () => {
    mocks.backupFindFirst.mockResolvedValue({
      checksum: "a".repeat(64),
      storageFilename: "backup.json"
    });
    mocks.readLocalBackupDocument.mockResolvedValue({
      file: {
        filename: "backup.json",
        absolutePath: "/private/backup.json",
        checksum: "a".repeat(64)
      },
      body: Buffer.from("backup")
    });

    await expect(downloadLocalBackupFile("backup.json")).resolves.toEqual({
      filename: "backup.json",
      body: Buffer.from("backup")
    });

    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "backup.manage");
    expect(mocks.backupFindFirst).toHaveBeenCalledWith({
      where: {
        householdId: "household-1",
        kind: { in: ["automated_export", "recovery_authorized"] },
        status: "complete",
        storageFilename: "backup.json"
      },
      select: { checksum: true, storageFilename: true }
    });
    expect(mocks.readLocalBackupDocument).toHaveBeenCalledWith("/var/lib/cubby/backups", "backup.json");
    expect(mocks.backupFindFirst.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.readLocalBackupDocument.mock.invocationCallOrder[0]!
    );
  });

  it("hides unassociated recovery files from a fresh sole household and rejects them before file access", async () => {
    const filename = "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json";
    const failedRecord = {
      id: "record-failed",
      createdAt: new Date("2026-07-15T21:30:00.000Z"),
      status: "failed",
      error: "backup_write_failed",
      checksum: null,
      itemCount: null,
      storageFilename: null
    };
    mocks.backupFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(failedRecord).mockResolvedValueOnce(null);
    mocks.backupCount.mockResolvedValue(1);
    mocks.scanLocalBackups.mockResolvedValue([{
      healthy: true,
      filename,
      exportedAt: "2026-07-14T20:00:00.000Z",
      householdName: "Recovered Home",
      checksum: "a".repeat(64),
      size: 100,
      itemCount: 1,
      absolutePath: "/private/recovery.json"
    }]);
    mocks.readLocalBackupDocument.mockResolvedValue({
      file: { filename, absolutePath: "/private/recovery.json", checksum: "a".repeat(64) },
      body: Buffer.from("recovery")
    });

    await expect(getAutomatedBackupStatus()).resolves.toMatchObject({ healthyVersionCount: 0, versions: [] });
    await expect(downloadLocalBackupFile(filename)).rejects.toThrow("not_found");
    expect(mocks.scanLocalBackups).toHaveBeenCalledWith("/var/lib/cubby/backups", []);
    expect(mocks.readLocalBackupDocument).not.toHaveBeenCalled();
  });

  it("does not bootstrap persisted files into an occupied sole household", async () => {
    const filename = "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json";
    mocks.freshState.mockResolvedValue([{ actorIsSoleOwner: true, operationalCount: 1n }]);
    mocks.scanLocalBackups.mockResolvedValue([{
      healthy: true,
      filename,
      exportedAt: "2026-07-14T20:00:00.000Z",
      householdName: "Other Home",
      checksum: "a".repeat(64),
      size: 100,
      absolutePath: "/private/other.json"
    }]);
    mocks.readLocalBackupDocument.mockResolvedValue({
      file: { filename, absolutePath: "/private/other.json", checksum: "a".repeat(64) },
      body: Buffer.from("other")
    });

    await expect(getAutomatedBackupStatus()).resolves.toMatchObject({ healthyVersionCount: 0, versions: [] });
    await expect(downloadLocalBackupFile(filename)).rejects.toThrow("not_found");
  });

  it("hides and rejects another household's persisted backup", async () => {
    const ownFilename = "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json";
    const otherFilename = "cubby-backup-v2-20260713T200000Z-bbbbbbbbbbbb.json";
    mocks.householdCount.mockResolvedValue(2);
    mocks.backupCount.mockResolvedValue(1);
    mocks.backupFindMany.mockResolvedValue([
      {
        id: "record-success",
        createdAt: new Date("2026-07-14T20:00:00.000Z"),
        status: "complete",
        error: null,
        checksum: "a".repeat(64),
        itemCount: 1,
        storageFilename: ownFilename
      }
    ]);
    mocks.scanLocalBackups.mockResolvedValue([
      {
        healthy: true,
        filename: ownFilename,
        exportedAt: "2026-07-14T20:00:00.000Z",
        householdName: "Home",
        checksum: "a".repeat(64),
        size: 100,
        absolutePath: "/private/own.json"
      },
      {
        healthy: true,
        filename: otherFilename,
        exportedAt: "2026-07-13T20:00:00.000Z",
        householdName: "Other Home",
        checksum: "b".repeat(64),
        size: 100,
        absolutePath: "/private/other.json"
      }
    ]);
    mocks.readLocalBackupDocument.mockResolvedValue({
      file: {
        filename: otherFilename,
        absolutePath: "/private/other.json",
        checksum: "b".repeat(64)
      },
      body: Buffer.from("other")
    });

    const status = await getAutomatedBackupStatus();
    await expect(downloadLocalBackupFile(otherFilename)).rejects.toThrow("not_found");

    expect(status.versions).toHaveLength(1);
    expect(status.versions[0]).toEqual(expect.objectContaining({ filename: ownFilename }));
  });

  it("rejects a malformed persisted filename before querying or opening storage", async () => {
    const malformedFilename = "../cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json";
    mocks.isLocalBackupFilename.mockReturnValue(false);
    mocks.backupFindFirst.mockResolvedValue({
      checksum: "a".repeat(64),
      storageFilename: malformedFilename
    });

    await expect(downloadLocalBackupFile(malformedFilename)).rejects.toThrow("not_found");

    expect(mocks.backupFindFirst).not.toHaveBeenCalled();
    expect(mocks.readLocalBackupDocument).not.toHaveBeenCalled();
  });

  it("restores unit preferences without rewriting activities", async () => {
    await expect(restoreBackupJson({
      version: 1,
      settings: { accentTheme: "sage", unitPreferences },
      babies: [],
      activities: []
    })).resolves.toEqual({ restored: 0, counts: { babies: 0, activities: 0 } });

    expect(mocks.settingsUpsert).toHaveBeenCalledWith({
      where: { householdId: "household-1" },
      update: { accentTheme: "sage", unitPreferences },
      create: { householdId: "household-1", accentTheme: "sage", unitPreferences }
    });
    expect(mocks.restoreActivity).not.toHaveBeenCalled();
  });

  it("ignores hostile membership fields without changing membership state", async () => {
    await expect(restoreBackupJson({
      version: 1,
      babies: [],
      activities: [],
      members: [{ id: "member-1", role: "owner", disabledAt: null }],
      household: {
        id: "household-1",
        members: [{ id: "member-1", role: "owner", disabledAt: null }]
      },
      disabledAt: null
    })).resolves.toEqual({ restored: 0, counts: { babies: 0, activities: 0 } });

    expect(mocks.memberCreate).not.toHaveBeenCalled();
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.memberUpdateMany).not.toHaveBeenCalled();
    expect(mocks.memberDelete).not.toHaveBeenCalled();
    expect(mocks.memberDeleteMany).not.toHaveBeenCalled();
  });

  it("accepts older v1 backups that do not contain unit preferences", async () => {
    await expect(restoreBackupJson({ version: 1, babies: [], activities: [] })).resolves.toEqual({
      restored: 0,
      counts: { babies: 0, activities: 0 }
    });
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
  });

  it("restores same-named legacy babies separately and counts babies", async () => {
    mocks.babyCreate
      .mockResolvedValueOnce({ id: "saved-baby-1", name: "Alex", inactiveAt: null })
      .mockResolvedValueOnce({ id: "saved-baby-2", name: "Alex", inactiveAt: null });

    await expect(restoreBackupJson({
      version: 1,
      babies: [
        { id: "source-baby-1", name: "Alex", timezone: "UTC" },
        { id: "source-baby-2", name: "Alex", timezone: "UTC" }
      ],
      activities: [
        { babyId: "source-baby-1", type: "note", occurredAt: "2026-07-14T10:00:00.000Z", text: "First" },
        { babyId: "source-baby-2", type: "note", occurredAt: "2026-07-14T11:00:00.000Z", text: "Second" }
      ]
    })).resolves.toEqual({ restored: 4, counts: { babies: 2, activities: 2 } });

    expect(mocks.babyCreate).toHaveBeenCalledTimes(2);
    expect(mocks.restoreActivity.mock.calls.map(([activity]) => activity.babyId)).toEqual(["saved-baby-1", "saved-baby-2"]);
    expect(mocks.backupCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ itemCount: 4 }) })
    );
  });

  it("drops unavailable contact and attachment relations from legacy activities", async () => {
    mocks.babyCreate.mockResolvedValue({ id: "saved-baby-1", name: "Alex", inactiveAt: null });

    await expect(restoreBackupJson({
      version: 1,
      babies: [{ id: "source-baby-1", name: "Alex", timezone: "UTC" }],
      activities: [{
        babyId: "source-baby-1",
        type: "medicine",
        occurredAt: "2026-07-14T10:00:00.000Z",
        name: "Vitamin D",
        contactId: "legacy-contact",
        documentUrl: "/legacy/private.pdf"
      }]
    })).resolves.toEqual({ restored: 2, counts: { babies: 1, activities: 1 } });

    const restoredInput = mocks.restoreActivity.mock.calls[0][0];
    expect(restoredInput).toMatchObject({ babyId: "saved-baby-1", name: "Vitamin D" });
    expect(restoredInput).not.toHaveProperty("contactId");
    expect(restoredInput).not.toHaveProperty("documentUrl");
  });

  it.each([
    {
      label: "duplicate legacy baby IDs",
      backup: {
        version: 1,
        babies: [
          { id: "source-baby", name: "One", timezone: "UTC" },
          { id: "source-baby", name: "Two", timezone: "UTC" }
        ],
        activities: []
      },
      error: "backup_duplicate_source_id"
    },
    {
      label: "dangling legacy baby reference",
      backup: {
        version: 1,
        babies: [],
        activities: [{ babyId: "foreign-baby", type: "note", occurredAt: "2026-07-14T10:00:00.000Z", text: "Unsafe" }]
      },
      error: "backup_dangling_reference"
    }
  ])("rejects $label before a restore transaction", async ({ backup, error }) => {
    await expect(restoreBackupJson(backup)).rejects.toThrow(error);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("exports baby inactivity timestamps when present", async () => {
    mocks.babyFindMany.mockResolvedValue([
      {
        id: "baby-1",
        name: "Finley",
        birthDate: null,
        timezone: "America/New_York",
        notes: null,
        inactiveAt: new Date("2026-07-14T12:00:00.000Z")
      }
    ]);

    const payload = JSON.parse(await exportBackupJson());

    expect(payload.payload.babies).toEqual([
      expect.objectContaining({
        id: "baby-1",
        inactiveAt: "2026-07-14T12:00:00.000Z"
      })
    ]);
  });

  it("exports stopped timer metadata without losing paused duration", async () => {
    mocks.babyFindMany.mockResolvedValue([{ id: "baby-1", name: "Finley", birthDate: null, timezone: "UTC", notes: null, inactiveAt: null }]);
    mocks.activityFindMany.mockResolvedValue([
      {
        id: "activity-1",
        babyId: "baby-1",
        type: "sleep",
        occurredAt: new Date("2026-07-14T10:00:00.000Z"),
        startedAt: new Date("2026-07-14T10:00:00.000Z"),
        endedAt: new Date("2026-07-14T11:00:00.000Z"),
        durationSeconds: 2700,
        timezone: "UTC",
        notes: null,
        timerState: "stopped",
        pausedAt: null,
        pausedSeconds: 900,
        sleep: { sleepType: null, location: null, quality: null }
      }
    ]);

    const payload = JSON.parse(await exportBackupJson());

    expect(payload.payload.activities[0]).toEqual(
      expect.objectContaining({
        timerState: "stopped",
        durationSeconds: 2700,
        pausedAt: null,
        pausedSeconds: 900
      })
    );
  });

  it.each(["running", "paused"])("rejects an exported %s timer without recording success", async (timerState) => {
    mocks.activityFindMany.mockResolvedValue([
      {
        id: "activity-live",
        babyId: "baby-1",
        type: "sleep",
        occurredAt: new Date("2026-07-14T10:00:00.000Z"),
        startedAt: new Date("2026-07-14T10:00:00.000Z"),
        endedAt: null,
        durationSeconds: null,
        timezone: "UTC",
        notes: null,
        timerState,
        pausedAt: timerState === "paused" ? new Date("2026-07-14T10:30:00.000Z") : null,
        pausedSeconds: 0,
        sleep: { sleepType: null, location: null, quality: null }
      }
    ]);

    await expect(exportBackupJson()).rejects.toThrow("backup_active_timer");

    expect(mocks.backupCreate).not.toHaveBeenCalled();
  });

  it.each([
    { label: "timer fields without a state", timer: { pausedSeconds: 1 } },
    {
      label: "partial none metadata",
      timer: { timerState: "none", durationSeconds: 3600, pausedSeconds: 0 }
    },
    {
      label: "contradictory none metadata",
      timer: {
        timerState: "none",
        durationSeconds: 3600,
        pausedAt: "2026-07-14T10:30:00.000Z",
        pausedSeconds: 0
      }
    },
    {
      label: "partial stopped metadata",
      timer: { timerState: "stopped", durationSeconds: 2700, pausedSeconds: 900 }
    },
    {
      label: "incoherent stopped duration",
      timer: { timerState: "stopped", durationSeconds: 2600, pausedAt: null, pausedSeconds: 900 }
    }
  ])("rejects $label before opening a restore transaction", async ({ timer }) => {
    await expect(
      restoreBackupJson({
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "UTC" }],
        activities: [
          {
            babyId: "backup-baby-1",
            type: "sleep",
            occurredAt: "2026-07-14T10:00:00.000Z",
            startedAt: "2026-07-14T10:00:00.000Z",
            endedAt: "2026-07-14T11:00:00.000Z",
            ...timer
          }
        ]
      })
    ).rejects.toThrow("backup_invalid_timer");

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("accepts a complete coherent none timer block from a current export", async () => {
    mocks.babyCreate.mockResolvedValue({ id: "saved-baby-1", name: "Finley", inactiveAt: null });

    await restoreBackupJson({
      version: 1,
      babies: [{ id: "backup-baby-1", name: "Finley", timezone: "UTC" }],
      activities: [
        {
          babyId: "backup-baby-1",
          type: "sleep",
          occurredAt: "2026-07-14T10:00:00.000Z",
          startedAt: "2026-07-14T10:00:00.000Z",
          endedAt: "2026-07-14T11:00:00.000Z",
          timerState: "none",
          durationSeconds: 3600,
          pausedAt: null,
          pausedSeconds: 0
        }
      ]
    });

    expect(mocks.restoreActivity).toHaveBeenCalledWith(expect.anything(), ctx, expect.anything(), undefined);
  });

  it("forwards exact stopped timer metadata to historical restore", async () => {
    mocks.babyCreate.mockResolvedValue({ id: "saved-baby-1", name: "Finley", inactiveAt: null });

    await restoreBackupJson({
      version: 1,
      babies: [{ id: "backup-baby-1", name: "Finley", timezone: "UTC" }],
      activities: [
        {
          babyId: "backup-baby-1",
          type: "sleep",
          occurredAt: "2026-07-14T10:00:00.000Z",
          startedAt: "2026-07-14T10:00:00.000Z",
          endedAt: "2026-07-14T11:00:00.000Z",
          timerState: "stopped",
          durationSeconds: 2700,
          pausedAt: null,
          pausedSeconds: 900
        }
      ]
    });

    expect(mocks.restoreActivity).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.anything(),
      { timerState: "stopped", durationSeconds: 2700, pausedSeconds: 900 }
    );
  });

  it("restores history and final inactivity in one transaction without temporary reactivation", async () => {
    const createdBaby = {
      id: "saved-baby-1",
      name: "Finley",
      birthDate: null,
      timezone: "America/New_York",
      notes: null,
      inactiveAt: null
    };
    mocks.babyCreate.mockResolvedValue(createdBaby);
    mocks.babyUpdate.mockResolvedValue({ ...createdBaby, inactiveAt: new Date("2026-07-14T12:00:00.000Z") });

    await expect(
      restoreBackupJson({
        version: 1,
        babies: [
          {
            id: "backup-baby-1",
            name: "Finley",
            timezone: "America/New_York",
            inactiveAt: "2026-07-14T12:00:00.000Z"
          }
        ],
        activities: [{ babyId: "backup-baby-1", type: "note", occurredAt: "2026-07-14T11:00:00.000Z", text: "nap note" }]
      })
    ).resolves.toEqual({ restored: 2, counts: { babies: 1, activities: 1 } });

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.restoreActivity).toHaveBeenCalledOnce();
    expect(mocks.restoreActivity.mock.invocationCallOrder[0]).toBeLessThan(mocks.babyUpdate.mock.invocationCallOrder[0]);
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ action: "backup.restore", entityId: "legacy-v1" }),
      expect.anything()
    );
  });

  it("rechecks backup permission with the locked current role before any restore write", async () => {
    mocks.lockActor.mockResolvedValue({ ...ctx, role: "parent" });
    mocks.requirePermission.mockImplementation((candidate, permission) => {
      if (candidate.role === "parent" && permission === "backup.manage") throw new Error("forbidden");
    });

    await expect(restoreBackupJson({ version: 1, babies: [], activities: [] })).rejects.toThrow("forbidden");

    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.babyCreate).not.toHaveBeenCalled();
    expect(mocks.backupCreate).not.toHaveBeenCalled();
  });

  it("rejects a restore containing a live timer before opening a transaction", async () => {
    await expect(
      restoreBackupJson({
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "America/New_York" }],
        activities: [
          { babyId: "backup-baby-1", type: "sleep", occurredAt: "2026-07-14T11:00:00.000Z", activeTimer: true }
        ]
      })
    ).rejects.toThrow("backup_active_timer");

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "inactiveAt",
      backup: {
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "America/New_York", inactiveAt: "not-a-date" }],
        activities: []
      }
    },
    {
      label: "birthDate",
      backup: {
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "America/New_York", birthDate: "not-a-date" }],
        activities: []
      }
    },
    {
      label: "activity occurredAt",
      backup: {
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "America/New_York" }],
        activities: [{ babyId: "backup-baby-1", type: "note", occurredAt: "not-a-date", text: "nap note" }]
      }
    }
  ])("rejects a malformed $label before opening a transaction", async ({ backup }) => {
    await expect(restoreBackupJson(backup)).rejects.toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("propagates activity restore failures and never records completion", async () => {
    mocks.babyCreate.mockResolvedValue({ id: "saved-baby-1", name: "Finley", inactiveAt: null });
    mocks.restoreActivity.mockRejectedValue(new Error("database_unavailable"));

    await expect(
      restoreBackupJson({
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "America/New_York" }],
        activities: [{ babyId: "backup-baby-1", type: "note", occurredAt: "2026-07-14T11:00:00.000Z", text: "nap note" }]
      })
    ).rejects.toThrow("database_unavailable");

    expect(mocks.backupCreate).not.toHaveBeenCalled();
  });

  it("rejects final inactivity when an existing active timer is present", async () => {
    const inactiveAt = new Date("2026-07-14T12:00:00.000Z");
    const existing = { id: "saved-baby-1", name: "Finley", inactiveAt: null };
    mocks.babyCreate.mockResolvedValue(existing);
    mocks.lockBaby.mockResolvedValue(existing);
    mocks.activityFindFirst.mockResolvedValue({ id: "timer-1" });

    await expect(
      restoreBackupJson({
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "America/New_York", inactiveAt: inactiveAt.toISOString() }],
        activities: []
      })
    ).rejects.toThrow("baby_has_active_timer");

    expect(mocks.babyUpdate).not.toHaveBeenCalled();
    expect(mocks.backupCreate).not.toHaveBeenCalled();
  });
});

function transactionClient() {
  return {
    $queryRaw: mocks.freshState,
    household: { findUniqueOrThrow: mocks.householdFind, update: mocks.householdUpdate },
    householdSettings: { findUnique: mocks.settingsFind, upsert: mocks.settingsUpsert },
    householdMember: { findUnique: vi.fn() },
    baby: {
      findMany: mocks.babyFindMany,
      findFirst: mocks.babyFindFirst,
      create: mocks.babyCreate,
      update: mocks.babyUpdate
    },
    activityLog: { findMany: mocks.activityFindMany, findFirst: mocks.activityFindFirst },
    contact: { findMany: mocks.contactFindMany, create: mocks.contactCreate },
    medicineCatalog: { findMany: mocks.catalogFindMany, create: mocks.catalogCreate },
    calendarEvent: { findMany: mocks.calendarFindMany, create: mocks.calendarCreate },
    reminder: { findMany: mocks.reminderFindMany, create: mocks.reminderCreate },
    backupRecord: { create: mocks.backupCreate }
  };
}
