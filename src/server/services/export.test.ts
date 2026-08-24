import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  transaction: vi.fn(),
  lockActorForWrite: vi.fn(),
  listActivities: vi.fn(),
  listActivitiesForContext: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/server/services/mutation-locks", () => ({ lockActorForWrite: mocks.lockActorForWrite }));
vi.mock("@/server/services/activities", () => ({
  listActivities: mocks.listActivities,
  listActivitiesForContext: mocks.listActivitiesForContext
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import { activityCsv } from "@/server/services/export";

const ownerContext = { userId: "user-1", householdId: "household-1", memberId: "member-1", role: "owner" };

describe("activity export audit boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEffectiveHouseholdContext.mockResolvedValue(ownerContext);
    mocks.requirePermission.mockImplementation((context) => {
      if (context.role !== "owner") throw new Error("forbidden");
    });
    mocks.transaction.mockImplementation(async (callback) => callback({ activityLog: { findMany: vi.fn() } }));
    mocks.lockActorForWrite.mockImplementation(async (_tx, context) => context);
    mocks.listActivities.mockResolvedValue([]);
    mocks.listActivitiesForContext.mockResolvedValue([]);
  });

  it("rechecks export authority inside one transaction before reading or auditing export data", async () => {
    mocks.lockActorForWrite.mockResolvedValue({ ...ownerContext, role: "read_only" });

    await expect(activityCsv()).rejects.toThrow("forbidden");

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.listActivitiesForContext).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});
