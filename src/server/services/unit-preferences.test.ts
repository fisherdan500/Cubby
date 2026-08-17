import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  settingsFindUnique: vi.fn(),
  queryRaw: vi.fn(),
  settingsUpsert: vi.fn(),
  medicineFindMany: vi.fn(),
  supplementFindMany: vi.fn(),
  writeAudit: vi.fn(),
  getBrowserOperationContextForHousehold: vi.fn(),
  issueHouseholdBrowserOperation: vi.fn(),
  executeHouseholdBrowserOperation: vi.fn()
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
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));

vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForHousehold: mocks.getBrowserOperationContextForHousehold,
  issueHouseholdBrowserOperation: mocks.issueHouseholdBrowserOperation,
  executeHouseholdBrowserOperation: mocks.executeHouseholdBrowserOperation
}));

import {
  getActivityUnitPreferences,
  getUnitPreferenceSettings,
  issueUnitPreferencesBrowserOperation,
  submitUnitPreferencesBrowserOperation
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
  mocks.getEffectiveHouseholdContext.mockResolvedValue(ctx);
  mocks.settingsFindUnique.mockResolvedValue(null);
  mocks.medicineFindMany.mockResolvedValue([]);
  mocks.supplementFindMany.mockResolvedValue([]);
  mocks.getBrowserOperationContextForHousehold.mockResolvedValue({ ...ctx, sessionId: "session-1" });
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


  it("propagates permission failures before reading settings", async () => {
    mocks.requirePermission.mockImplementation(() => {
      throw new Error("forbidden");
    });

    await expect(getUnitPreferenceSettings()).rejects.toThrow("forbidden");
    expect(mocks.settingsFindUnique).not.toHaveBeenCalled();
  });

  it("issues a payload-free household units binding from an absent settings row", async () => {
    mocks.issueHouseholdBrowserOperation.mockResolvedValue({ status: "open", operationId: "bmo_0123456789abcdefghjkmnpqrs", bindingId: "binding-1" });

    await expect(issueUnitPreferencesBrowserOperation({ operationId: "bmo_0123456789abcdefghjkmnpqrs" })).resolves.toMatchObject({ status: "open" });
    const input = mocks.issueHouseholdBrowserOperation.mock.calls[0][0];
    expect(input).toMatchObject({ operationId: "bmo_0123456789abcdefghjkmnpqrs", operationKey: "settingsUnitsUpdate", targetKind: "settings", permission: "household.manage" });
    await expect(input.targetSnapshot({ $queryRaw: mocks.queryRaw, householdSettings: { findUnique: mocks.settingsFindUnique } }, ctx)).resolves.toEqual({ settingsState: "absent", updatedAt: null, unitPreferences: { volume: "oz", weight: "lb", length: "in", temperature: "F", medicineUnits: {}, supplementUnits: {} }, schemaVersion: 1 });
  });

  it("submits one complete normalized units document with settings revision CAS and audit in the operation transaction", async () => {
    mocks.executeHouseholdBrowserOperation.mockImplementation(async (input) => {
      const settingsUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      await expect(input.execute({ $queryRaw: mocks.queryRaw, householdSettings: { findUnique: vi.fn().mockResolvedValue({ unitPreferences: preferences, updatedAt: new Date("2026-08-17T12:00:00.000Z") }), updateMany: settingsUpdateMany }, auditEvent: { create: mocks.writeAudit } }, ctx, { targetSnapshot: { settingsState: "present", updatedAt: "2026-08-17T12:00:00.000Z", unitPreferences: preferences, schemaVersion: 1 } })).resolves.toEqual({ kind: "units_updated", code: "ok", settingsScope: "household" });
      expect(settingsUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ householdId: "household-1" }) }));
      return { status: "completed", operationId: "bmo_0123456789abcdefghjkmnpqrs", outcome: { kind: "units_updated", code: "ok", settingsScope: "household" } };
    });

    await expect(submitUnitPreferencesBrowserOperation({ operationId: "bmo_0123456789abcdefghjkmnpqrs", ...preferences })).resolves.toMatchObject({ status: "completed" });
    expect(mocks.executeHouseholdBrowserOperation).toHaveBeenCalledWith(expect.objectContaining({ intent: preferences, operationKey: "settingsUnitsUpdate" }));
  });
});
