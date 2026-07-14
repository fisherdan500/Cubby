import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  settingsFindUnique: vi.fn(),
  settingsUpsert: vi.fn(),
  medicineFindMany: vi.fn(),
  supplementFindMany: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    householdSettings: {
      findUnique: mocks.settingsFindUnique,
      upsert: mocks.settingsUpsert
    },
    medicineLog: { findMany: mocks.medicineFindMany },
    supplementLog: { findMany: mocks.supplementFindMany }
  }
}));

vi.mock("@/server/auth/context", () => ({
  getHouseholdContext: mocks.getHouseholdContext,
  requirePermission: mocks.requirePermission
}));

vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import {
  getActivityUnitPreferences,
  getUnitPreferenceSettings,
  updateUnitPreferences
} from "@/server/services/unit-preferences";

const ctx = {
  userId: "user-1",
  householdId: "household-1",
  memberId: "member-1",
  role: "owner"
};

const preferences = {
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
  mocks.settingsFindUnique.mockResolvedValue(null);
  mocks.medicineFindMany.mockResolvedValue([]);
  mocks.supplementFindMany.mockResolvedValue([]);
});

describe("unit preference service", () => {
  it("lets activity readers reuse logged item names with safe defaults", async () => {
    mocks.medicineFindMany.mockResolvedValue([{ name: "Ibuprofen" }]);
    mocks.supplementFindMany.mockResolvedValue([{ name: "Probiotic" }]);

    await expect(getActivityUnitPreferences()).resolves.toEqual({
      preferences: {
        volume: "oz",
        weight: "lb",
        length: "in",
        temperature: "F",
        medicineUnits: {},
        supplementUnits: {}
      },
      medicineNames: ["Ibuprofen"],
      supplementNames: ["Probiotic"]
    });
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "activity.read");
    expect(mocks.settingsFindUnique).toHaveBeenCalledWith({
      where: { householdId: "household-1" },
      select: { unitPreferences: true }
    });
  });

  it("returns manager settings with household-scoped logged and configured item names", async () => {
    mocks.settingsFindUnique.mockResolvedValue({ unitPreferences: preferences });
    mocks.medicineFindMany.mockResolvedValue([{ name: "acetaminophen" }, { name: "Ibuprofen" }]);
    mocks.supplementFindMany.mockResolvedValue([{ name: "Vitamin D" }, { name: "Probiotic" }]);

    await expect(getUnitPreferenceSettings()).resolves.toEqual({
      preferences,
      medicineNames: ["Acetaminophen", "Ibuprofen"],
      supplementNames: ["Probiotic", "Vitamin D"]
    });
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "household.manage");
    expect(mocks.medicineFindMany.mock.calls[0][0].where.activity).toEqual({
      householdId: "household-1",
      deletedAt: null
    });
  });

  it("validates and stores manager updates without changing activity records", async () => {
    mocks.settingsUpsert.mockResolvedValue({ unitPreferences: preferences });

    await expect(updateUnitPreferences(preferences)).resolves.toEqual(preferences);
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "household.manage");
    expect(mocks.settingsUpsert).toHaveBeenCalledWith({
      where: { householdId: "household-1" },
      update: { unitPreferences: preferences },
      create: { householdId: "household-1", unitPreferences: preferences }
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        action: "settings.units.update",
        entityType: "household",
        entityId: "household-1",
        after: preferences
      })
    );
  });

  it("rejects invalid updates before persistence", async () => {
    await expect(updateUnitPreferences({ ...preferences, volume: "cups" })).rejects.toThrow();
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("propagates permission failures before reading settings", async () => {
    mocks.requirePermission.mockImplementation(() => {
      throw new Error("forbidden");
    });

    await expect(getUnitPreferenceSettings()).rejects.toThrow("forbidden");
    expect(mocks.settingsFindUnique).not.toHaveBeenCalled();
  });
});
