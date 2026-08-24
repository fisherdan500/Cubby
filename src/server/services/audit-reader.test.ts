import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  auditFindMany: vi.fn(),
  auditCreate: vi.fn(),
  babyFindFirst: vi.fn(),
  transaction: vi.fn(),
  lockActorForWrite: vi.fn()
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    auditEvent: {
      findMany: mocks.auditFindMany,
      create: mocks.auditCreate
    }
  }
}));
vi.mock("@/server/services/mutation-locks", () => ({
  lockActorForWrite: mocks.lockActorForWrite
}));

import { exportHouseholdAuditCsv, listBabySafetyHistory, listHouseholdAuditEvents } from "@/server/services/audit-reader";

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
    mocks.transaction.mockImplementation(async (callback) => callback({
      auditEvent: {
        findMany: mocks.auditFindMany,
        create: mocks.auditCreate
      },
      baby: {
        findFirst: mocks.babyFindFirst
      }
    }));
    mocks.lockActorForWrite.mockImplementation(async (_tx, context) => context);
    mocks.babyFindFirst.mockResolvedValue({ id: "baby-1" });
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

  it("returns a minimized, keyset-paginated household-scoped audit view and records the view", async () => {
    mocks.auditFindMany.mockResolvedValueOnce([
      {
        id: "audit-2",
        action: "activity.create",
        entityType: "activity",
        entityId: "activity-2",
        schemaVersion: 1,
        correlationId: null,
        actorUserSnapshot: "user-1",
        actorMemberSnapshot: "member-1",
        createdAt: new Date("2026-08-21T00:01:00.000Z")
      },
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
    await expect(listHouseholdAuditEvents({ limit: 1 })).resolves.toEqual({
      events: [expect.objectContaining({
        id: "audit-2",
        action: "activity.create",
        entityId: "activity-2"
      })],
      nextCursor: expect.any(String)
    });

    expect(mocks.auditFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { householdId: "household-1" },
      take: 2
    }));
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "audit.view", entityType: "audit" })
    }));
  });

  it("keeps a supplied keyset cursor household-scoped", async () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: "2026-08-21T00:00:00.000Z", id: "audit-1" })).toString("base64url");

    await listHouseholdAuditEvents({ cursor });

    expect(mocks.auditFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        householdId: "household-1",
        OR: [
          { createdAt: { lt: new Date("2026-08-21T00:00:00.000Z") } },
          { createdAt: new Date("2026-08-21T00:00:00.000Z"), id: { lt: "audit-1" } }
        ]
      }
    }));
  });

  it("rejects a non-owner, non-admin reader before querying audit history", async () => {
    mocks.getEffectiveHouseholdContext.mockResolvedValue({ ...ownerContext, role: "parent" });

    await expect(listHouseholdAuditEvents()).rejects.toThrow("forbidden");
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("rechecks the reader's current role inside the audit-read transaction before querying history", async () => {
    mocks.lockActorForWrite.mockResolvedValue({ ...ownerContext, role: "parent" });

    await expect(listHouseholdAuditEvents()).rejects.toThrow("forbidden");

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.lockActorForWrite).toHaveBeenCalledTimes(1);
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("returns only the selected baby's medicine and vaccine lifecycle projection to a parent", async () => {
    mocks.getEffectiveHouseholdContext.mockResolvedValue({ ...ownerContext, role: "parent" });
    mocks.auditFindMany.mockResolvedValue([
      {
        id: "audit-1",
        action: "activity.create",
        babyId: "baby-1",
        actorUserSnapshot: "user-1",
        actorMemberSnapshot: "member-1",
        createdAt: new Date("2026-08-22T00:00:00.000Z"),
        after: { type: "medicine", notes: "must-not-disclose" }
      },
      {
        id: "audit-2",
        action: "activity.create",
        babyId: "baby-1",
        actorUserSnapshot: "user-1",
        actorMemberSnapshot: "member-1",
        createdAt: new Date("2026-08-22T00:01:00.000Z"),
        after: { type: "feeding" }
      },
      {
        id: "audit-3",
        action: "baby.deactivate",
        babyId: "baby-1",
        actorUserSnapshot: "user-1",
        actorMemberSnapshot: "member-1",
        createdAt: new Date("2026-08-22T00:02:00.000Z"),
        after: { inactiveAt: "2026-08-22T00:02:00.000Z" }
      }
    ]);

    await expect(listBabySafetyHistory("baby-1")).resolves.toEqual([
      {
        action: "activity.create",
        actorUserSnapshot: "user-1",
        actorMemberSnapshot: "member-1",
        createdAt: new Date("2026-08-22T00:00:00.000Z"),
        type: "medicine"
      },
      {
        action: "baby.deactivate",
        actorUserSnapshot: "user-1",
        actorMemberSnapshot: "member-1",
        createdAt: new Date("2026-08-22T00:02:00.000Z")
      }
    ]);
    expect(mocks.auditFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ householdId: "household-1", babyId: "baby-1" })
    }));
  });

  it("keeps a foreign or missing baby existence-neutral without recording an audit projection", async () => {
    mocks.getEffectiveHouseholdContext.mockResolvedValue({ ...ownerContext, role: "parent" });
    mocks.babyFindFirst.mockResolvedValue(null);

    await expect(listBabySafetyHistory("foreign-baby")).resolves.toEqual([]);

    expect(mocks.babyFindFirst).toHaveBeenCalledWith({
      where: { id: "foreign-baby", householdId: "household-1", deletedAt: null },
      select: { id: true }
    });
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("exports only the minimized owner/admin audit columns and records the export", async () => {
    await expect(exportHouseholdAuditCsv()).resolves.toContain('"activity.create"');

    expect(mocks.auditFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { householdId: "household-1" } }));
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "audit.export", entityType: "audit" })
    }));
  });

  it("rechecks export authorization inside its transaction before querying or recording an export", async () => {
    mocks.lockActorForWrite.mockResolvedValue({ ...ownerContext, role: "parent" });

    await expect(exportHouseholdAuditCsv()).rejects.toThrow("forbidden");

    expect(mocks.auditFindMany).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
