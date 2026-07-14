import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  householdFind: vi.fn(),
  settingsFind: vi.fn(),
  settingsUpsert: vi.fn(),
  babyFindMany: vi.fn(),
  activityFindMany: vi.fn(),
  backupCreate: vi.fn(),
  createActivity: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    household: { findUniqueOrThrow: mocks.householdFind },
    householdSettings: { findUnique: mocks.settingsFind, upsert: mocks.settingsUpsert },
    baby: { findMany: mocks.babyFindMany, findFirst: vi.fn(), create: vi.fn() },
    activityLog: { findMany: mocks.activityFindMany },
    backupRecord: { create: mocks.backupCreate }
  }
}));

vi.mock("@/server/auth/context", () => ({
  getHouseholdContext: mocks.getHouseholdContext,
  requirePermission: mocks.requirePermission
}));

vi.mock("@/server/services/activities", () => ({
  activityInclude: {},
  createActivity: mocks.createActivity
}));

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
  mocks.activityFindMany.mockResolvedValue([]);
  mocks.backupCreate.mockResolvedValue({ id: "backup-1" });
  mocks.settingsUpsert.mockResolvedValue({});
});

describe("backup unit preferences", () => {
  it("exports canonical household unit preferences", async () => {
    const payload = JSON.parse(await exportBackupJson());

    expect(payload.settings.unitPreferences).toEqual(unitPreferences);
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
    expect(mocks.createActivity).not.toHaveBeenCalled();
  });

  it("accepts older v1 backups that do not contain unit preferences", async () => {
    await expect(restoreBackupJson({ version: 1, babies: [], activities: [] })).resolves.toEqual({ restored: 0 });
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
  });
});
