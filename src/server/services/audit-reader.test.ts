import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn()
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    auditEvent: {
      findMany: mocks.auditFindMany,
      create: mocks.auditCreate
    }
  }
}));

import { listHouseholdAuditEvents } from "@/server/services/audit-reader";

const ownerContext = {
  userId: "user-1",
  householdId: "household-1",
  memberId: "member-1",
  role: "owner" as const
};

describe("household audit reader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEffectiveHouseholdContext.mockResolvedValue(ownerContext);
    mocks.auditFindMany.mockResolvedValue([
      {
        id: "audit-1",
        action: "activity.create",
        entityType: "activity",
        entityId: "activity-1",
        schemaVersion: 1,
        correlationId: null,
        actorUserSnapshot: "user-1",
        actorMemberSnapshot: "member-1",
        createdAt: new Date("2026-08-21T00:00:00.000Z")
      }
    ]);
  });

  it("returns a minimized household-scoped audit view and records the view", async () => {
    await expect(listHouseholdAuditEvents()).resolves.toEqual([
      expect.objectContaining({
        id: "audit-1",
        action: "activity.create",
        entityId: "activity-1"
      })
    ]);

    expect(mocks.auditFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { householdId: "household-1" }
    }));
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "audit.view", entityType: "audit" })
    }));
  });
});
