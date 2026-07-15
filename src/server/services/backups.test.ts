import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  householdFind: vi.fn(),
  settingsFind: vi.fn(),
  settingsUpsert: vi.fn(),
  babyFindMany: vi.fn(),
  babyFindFirst: vi.fn(),
  babyCreate: vi.fn(),
  babyUpdate: vi.fn(),
  activityFindMany: vi.fn(),
  activityFindFirst: vi.fn(),
  backupCreate: vi.fn(),
  restoreActivity: vi.fn(),
  transaction: vi.fn(),
  lockActor: vi.fn(),
  lockBaby: vi.fn(),
  writeAudit: vi.fn(),
  memberCreate: vi.fn(),
  memberUpdate: vi.fn(),
  memberUpdateMany: vi.fn(),
  memberDelete: vi.fn(),
  memberDeleteMany: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    household: { findUniqueOrThrow: mocks.householdFind },
    householdSettings: { findUnique: mocks.settingsFind, upsert: mocks.settingsUpsert },
    baby: {
      findMany: mocks.babyFindMany,
      findFirst: mocks.babyFindFirst,
      create: mocks.babyCreate,
      update: mocks.babyUpdate
    },
    activityLog: { findMany: mocks.activityFindMany, findFirst: mocks.activityFindFirst },
    backupRecord: { create: mocks.backupCreate },
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

import { exportBackupJson, restoreBackupJson } from "@/server/services/backups";

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
  mocks.backupCreate.mockResolvedValue({ id: "backup-1" });
  mocks.settingsUpsert.mockResolvedValue({});
});

describe("backup unit preferences", () => {
  it("exports canonical household unit preferences", async () => {
    const payload = JSON.parse(await exportBackupJson());

    expect(payload.settings.unitPreferences).toEqual(unitPreferences);
    expect(payload).not.toHaveProperty("members");
    expect(payload.household).not.toHaveProperty("members");
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "backup.manage");
  });

  it("restores unit preferences without rewriting activities", async () => {
    await expect(restoreBackupJson({
      version: 1,
      settings: { accentTheme: "sage", unitPreferences },
      babies: [],
      activities: []
    })).resolves.toEqual({ restored: 0 });

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
    })).resolves.toEqual({ restored: 0 });

    expect(mocks.memberCreate).not.toHaveBeenCalled();
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.memberUpdateMany).not.toHaveBeenCalled();
    expect(mocks.memberDelete).not.toHaveBeenCalled();
    expect(mocks.memberDeleteMany).not.toHaveBeenCalled();
  });

  it("accepts older v1 backups that do not contain unit preferences", async () => {
    await expect(restoreBackupJson({ version: 1, babies: [], activities: [] })).resolves.toEqual({ restored: 0 });
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
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

    expect(payload.babies).toEqual([
      expect.objectContaining({
        id: "baby-1",
        inactiveAt: "2026-07-14T12:00:00.000Z"
      })
    ]);
  });

  it("exports stopped timer metadata without losing paused duration", async () => {
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

    expect(payload.activities[0]).toEqual(
      expect.objectContaining({
        timerState: "stopped",
        durationSeconds: 2700,
        pausedAt: null,
        pausedSeconds: 900
      })
    );
  });

  it.each(["running", "paused"])("rejects an exported %s timer before opening a restore transaction", async (timerState) => {
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
    const payload = JSON.parse(await exportBackupJson());
    mocks.transaction.mockClear();

    await expect(restoreBackupJson(payload)).rejects.toThrow("backup_active_timer");

    expect(payload.activities[0]).toEqual(expect.objectContaining({ activeTimer: true, timerState }));
    expect(mocks.transaction).not.toHaveBeenCalled();
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
    ).resolves.toEqual({ restored: 1 });

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.restoreActivity).toHaveBeenCalledOnce();
    expect(mocks.restoreActivity.mock.invocationCallOrder[0]).toBeLessThan(mocks.babyUpdate.mock.invocationCallOrder[0]);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ action: "baby.deactivate", entityId: "saved-baby-1" }),
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

  it("restores historical activity into an already-inactive baby without a lifecycle transition", async () => {
    const inactiveAt = new Date("2026-07-14T12:00:00.000Z");
    const existing = {
      id: "saved-baby-1",
      name: "Finley",
      inactiveAt
    };
    mocks.babyFindMany.mockResolvedValue([existing]);
    mocks.lockBaby.mockResolvedValue(existing);

    await expect(
      restoreBackupJson({
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "America/New_York", inactiveAt: inactiveAt.toISOString() }],
        activities: [{ babyId: "backup-baby-1", type: "note", occurredAt: "2026-07-14T11:00:00.000Z", text: "nap note" }]
      })
    ).resolves.toEqual({ restored: 1 });

    expect(mocks.restoreActivity).toHaveBeenCalledOnce();
    expect(mocks.babyUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "baby.reactivate" }), expect.anything());
    expect(mocks.writeAudit).not.toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "baby.deactivate" }), expect.anything());
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
    mocks.babyFindMany.mockResolvedValue([existing]);
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
    $queryRaw: vi.fn(),
    householdSettings: { upsert: mocks.settingsUpsert },
    householdMember: { findUnique: vi.fn() },
    baby: {
      findMany: mocks.babyFindMany,
      findFirst: mocks.babyFindFirst,
      create: mocks.babyCreate,
      update: mocks.babyUpdate
    },
    activityLog: { findFirst: mocks.activityFindFirst },
    backupRecord: { create: mocks.backupCreate }
  };
}
