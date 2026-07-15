import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission } from "@/domain/roles";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  babyFindFirst: vi.fn(),
  babyFindMany: vi.fn(),
  babyUpdate: vi.fn(),
  activityFindFirst: vi.fn(),
  memberFindUnique: vi.fn(),
  memberLock: vi.fn(),
  transaction: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    baby: {
      findFirst: mocks.babyFindFirst,
      findMany: mocks.babyFindMany,
      update: mocks.babyUpdate
    },
    activityLog: {
      findFirst: mocks.activityFindFirst
    },
    $transaction: mocks.transaction
  }
}));

vi.mock("@/server/auth/context", () => ({
  getHouseholdContext: mocks.getHouseholdContext,
  requirePermission: mocks.requirePermission
}));

vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import { deactivateBaby, reactivateBaby } from "@/server/services/households";

describe("reversible baby inactivity", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getHouseholdContext.mockResolvedValue({
      userId: "user-owner",
      householdId: "household-1",
      memberId: "member-owner",
      role: "owner"
    });
    mocks.requirePermission.mockImplementation((ctx, permission) => {
      if (!hasPermission(ctx.role, permission)) throw new Error("forbidden");
    });
    mocks.memberLock.mockImplementation((strings: TemplateStringsArray) =>
      Promise.resolve([{ id: strings.join("").includes('"HouseholdMember"') ? "member-owner" : "baby-1" }])
    );
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-owner",
      householdId: "household-1",
      role: "owner",
      disabledAt: null,
      deletedAt: null
    });
    mocks.transaction.mockImplementation((operation) =>
      operation({
        $queryRaw: mocks.memberLock,
        baby: {
          findFirst: mocks.babyFindFirst,
          update: mocks.babyUpdate
        },
        householdMember: {
          findUnique: mocks.memberFindUnique
        },
        activityLog: {
          findFirst: mocks.activityFindFirst
        },
        auditEvent: {}
      })
    );
  });

  it("blocks deactivation when the baby has a running timer", async () => {
    mocks.babyFindFirst.mockResolvedValue({
      id: "baby-1",
      householdId: "household-1",
      inactiveAt: null,
      deletedAt: null
    });
    mocks.activityFindFirst.mockResolvedValue({ id: "timer-1", timerState: "running" });

    await expect(deactivateBaby("baby-1")).rejects.toThrow("baby_has_active_timer");

    expect(mocks.babyUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("is idempotent and audits only the actual deactivate transition", async () => {
    const inactiveAt = new Date("2026-07-14T12:00:00.000Z");
    let reads = 0;
    mocks.babyFindFirst.mockImplementation(() => {
      reads += 1;
      return Promise.resolve(
        reads === 1
          ? { id: "baby-1", householdId: "household-1", inactiveAt: null, deletedAt: null }
          : { id: "baby-1", householdId: "household-1", inactiveAt, deletedAt: null }
      );
    });
    mocks.activityFindFirst.mockResolvedValue(null);
    mocks.babyUpdate.mockResolvedValue({ id: "baby-1", householdId: "household-1", inactiveAt, deletedAt: null });

    await expect(Promise.all([deactivateBaby("baby-1"), deactivateBaby("baby-1")])).resolves.toEqual([
      { id: "baby-1", householdId: "household-1", inactiveAt, deletedAt: null },
      { id: "baby-1", householdId: "household-1", inactiveAt, deletedAt: null }
    ]);

    expect(mocks.babyUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "baby.deactivate", entityId: "baby-1" }),
      expect.anything()
    );
  });

  it("is idempotent and audits only the actual reactivate transition", async () => {
    const inactiveAt = new Date("2026-07-14T12:00:00.000Z");
    let reads = 0;
    mocks.babyFindFirst.mockImplementation(() => {
      reads += 1;
      return Promise.resolve(
        reads === 1
          ? { id: "baby-1", householdId: "household-1", inactiveAt, deletedAt: null }
          : { id: "baby-1", householdId: "household-1", inactiveAt: null, deletedAt: null }
      );
    });
    mocks.babyUpdate.mockResolvedValue({ id: "baby-1", householdId: "household-1", inactiveAt: null, deletedAt: null });

    await expect(Promise.all([reactivateBaby("baby-1"), reactivateBaby("baby-1")])).resolves.toEqual([
      { id: "baby-1", householdId: "household-1", inactiveAt: null, deletedAt: null },
      { id: "baby-1", householdId: "household-1", inactiveAt: null, deletedAt: null }
    ]);

    expect(mocks.babyUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "baby.reactivate", entityId: "baby-1" }),
      expect.anything()
    );
  });
});
