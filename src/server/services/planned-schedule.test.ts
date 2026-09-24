import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOperationKey } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  getBabyContext: vi.fn(),
  getHouseholdContext: vi.fn(),
  issueBrowser: vi.fn(),
  executeBrowser: vi.fn(),
  findFirst: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForBaby: mocks.getBabyContext,
  issueBrowserOperation: mocks.issueBrowser,
  executeBrowserOperation: mocks.executeBrowser
}));
vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getHouseholdContext,
  requirePermission: vi.fn()
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: { plannedSchedule: { findFirst: mocks.findFirst } } }));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import {
  getPlannedSchedule,
  issuePlannedScheduleBrowserOperation,
  submitPlannedScheduleBrowserOperation
} from "@/server/services/planned-schedule";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const ctx = { userId: "user-1", sessionId: "session-1", householdId: "household-1", memberId: "member-1", role: "parent" };
const baby = { id: "baby-1", inactiveAt: null, updatedAt: new Date("2026-09-24T00:00:00Z") };
const items = [
  { kind: "bedtime", label: null, timing: { mode: "exact", at: "19:15" }, note: "Two books, then lights out" },
  { kind: "wake", label: null, timing: { mode: "exact", at: "06:30" }, note: null }
];

/** A transaction whose plan row sits at `revision` (0: no plan yet). */
function transaction(revision: number) {
  return {
    $queryRaw: vi.fn().mockResolvedValue(revision ? [{ revision }] : []),
    plannedSchedule: { create: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) }
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getBabyContext.mockResolvedValue(ctx);
  mocks.getHouseholdContext.mockResolvedValue(ctx);
  mocks.issueBrowser.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
});

describe("planned schedule", () => {
  it("shows a baby's plan in time order, and whether this member may change it", async () => {
    mocks.findFirst.mockResolvedValue({ revision: 3, document: { schemaVersion: 1, items } });
    await expect(getPlannedSchedule("baby-1")).resolves.toMatchObject({ revision: 3, canEdit: true, items: [{ kind: "wake" }, { kind: "bedtime" }] });

    mocks.getHouseholdContext.mockResolvedValue({ ...ctx, role: "caretaker" });
    mocks.findFirst.mockResolvedValue(null);
    await expect(getPlannedSchedule("baby-1")).resolves.toEqual({ babyId: "baby-1", revision: 0, items: [], canEdit: false });
  });

  it("binds a save to the baby, for members who manage babies, from the revision the editor was opened on", async () => {
    await issuePlannedScheduleBrowserOperation({ operationId, babyId: "baby-1", expectedRevision: 2 });
    const call = mocks.issueBrowser.mock.calls[0][0];

    expect(call).toMatchObject({
      operationKey: BrowserOperationKey.plannedScheduleSave,
      opening: { babyId: "baby-1", expectedRevision: 2 },
      babyId: "baby-1",
      targetKind: "baby",
      targetId: "baby-1",
      permission: "baby.manage"
    });
    await expect(call.targetSnapshot(transaction(2), ctx, baby)).resolves.toEqual({ kind: "planned-schedule-save", schemaVersion: 1, babyId: "baby-1", revision: 2 });
  });

  it("refuses to open a save over a plan someone else changed after the editor loaded", async () => {
    await issuePlannedScheduleBrowserOperation({ operationId, babyId: "baby-1", expectedRevision: 2 });
    const call = mocks.issueBrowser.mock.calls[0][0];
    await expect(call.validate(transaction(3), ctx, baby)).rejects.toThrow("stale_revision");
  });

  it("creates the first plan and audits only that it changed", async () => {
    const tx = transaction(0);
    mocks.executeBrowser.mockImplementation(async (contract) => {
      await contract.validate(tx, ctx, baby, { targetSnapshot: { kind: "planned-schedule-save", schemaVersion: 1, babyId: "baby-1", revision: 0 } });
      return contract.execute(tx, ctx, baby);
    });

    await expect(submitPlannedScheduleBrowserOperation({ operationId, babyId: "baby-1", items })).resolves.toEqual({
      kind: "planned_schedule", code: "ok", babyId: "baby-1", revision: 1, itemCount: 2
    });
    expect(tx.plannedSchedule.create).toHaveBeenCalledWith({
      data: { householdId: "household-1", babyId: "baby-1", revision: 1, document: { schemaVersion: 1, items: [expect.objectContaining({ kind: "wake" }), expect.objectContaining({ kind: "bedtime" })] } }
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "planned_schedule.save", after: { revision: 1, itemCount: 2 } }), tx);
    expect(JSON.stringify(mocks.writeAudit.mock.calls)).not.toContain("Two books");
  });

  it("replaces an existing plan only at the revision it was opened on", async () => {
    const tx = transaction(4);
    mocks.executeBrowser.mockImplementation((contract) => contract.execute(tx, ctx, baby));

    await submitPlannedScheduleBrowserOperation({ operationId, babyId: "baby-1", items });
    expect(tx.plannedSchedule.updateMany).toHaveBeenCalledWith({
      where: { householdId: "household-1", babyId: "baby-1", revision: 4 },
      data: expect.objectContaining({ revision: 5 })
    });
  });

  it("rejects a save when the plan changed between opening and saving", async () => {
    mocks.executeBrowser.mockImplementation((contract) =>
      contract.validate(transaction(5), ctx, baby, { targetSnapshot: { kind: "planned-schedule-save", schemaVersion: 1, babyId: "baby-1", revision: 4 } })
    );
    await expect(submitPlannedScheduleBrowserOperation({ operationId, babyId: "baby-1", items })).rejects.toThrow("stale_revision");
  });

  it("checks the plan before any operation runs", async () => {
    await expect(submitPlannedScheduleBrowserOperation({
      operationId, babyId: "baby-1", items: [{ kind: "medicine", label: null, timing: { mode: "exact", at: "08:00" }, note: null }]
    })).rejects.toThrow();
    expect(mocks.executeBrowser).not.toHaveBeenCalled();
  });
});
