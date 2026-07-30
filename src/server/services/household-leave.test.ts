import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireFreshSession: vi.fn(),
  memberFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  memberCount: vi.fn(),
  activityCount: vi.fn(),
  inviteCount: vi.fn(),
  notificationPreferenceCount: vi.fn(),
  pushSubscriptionCount: vi.fn(),
  txMemberFindFirst: vi.fn(),
  memberUpdate: vi.fn(),
  inviteUpdateMany: vi.fn(),
  notificationPreferenceDeleteMany: vi.fn(),
  pushSubscriptionUpdateMany: vi.fn(),
  auditCreate: vi.fn(),
  sessionDeleteMany: vi.fn(),
  policyLock: vi.fn(),
  memberLock: vi.fn(),
  sessionLock: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/server/auth/session", () => ({
  requireUser: mocks.requireUser,
  requireFreshSession: mocks.requireFreshSession
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    householdMember: {
      findFirst: mocks.memberFindFirst,
      findMany: mocks.memberFindMany,
      count: mocks.memberCount
    },
    activityLog: { count: mocks.activityCount },
    invite: { count: mocks.inviteCount },
    notificationPreference: { count: mocks.notificationPreferenceCount },
    pushSubscription: { count: mocks.pushSubscriptionCount },
    session: { deleteMany: mocks.sessionDeleteMany },
    $transaction: mocks.transaction
  }
}));

import {
  getHouseholdLeaveOptions,
  getHouseholdLeavePreview,
  leaveHousehold
} from "@/server/services/household-leave";

const now = new Date("2026-07-29T23:30:00.000Z");
const operationId = "11111111-1111-4111-8111-111111111111";

function membership(role = "parent", disabledAt: Date | null = null) {
  return {
    id: "member-current",
    householdId: "household-1",
    userId: "user-1",
    role,
    disabledAt,
    deletedAt: null,
    closureReason: null,
    leaveOperationId: null,
    household: { name: "River House" }
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.requireUser.mockResolvedValue({ id: "user-1", email: "member@example.test" });
  mocks.requireFreshSession.mockResolvedValue({
    user: { id: "user-1", email: "member@example.test" },
    session: {
      id: "session-1",
      createdAt: new Date("2026-07-29T23:25:00.000Z")
    }
  });
  mocks.memberFindFirst.mockResolvedValue(membership());
  mocks.memberFindMany.mockResolvedValue([]);
  mocks.memberCount.mockResolvedValue(1);
  mocks.activityCount.mockResolvedValue(0);
  mocks.inviteCount.mockResolvedValue(0);
  mocks.notificationPreferenceCount.mockResolvedValue(0);
  mocks.pushSubscriptionCount.mockResolvedValue(0);
  mocks.txMemberFindFirst.mockImplementation(({ where }) =>
    where.leaveOperationId ? null : membership()
  );
  mocks.memberUpdate.mockResolvedValue({
    ...membership(),
    deletedAt: now,
    closureReason: "self_left",
    leaveOperationId: operationId
  });
  mocks.memberLock.mockResolvedValue([{ id: "member-current" }]);
  mocks.sessionLock.mockResolvedValue([{
    id: "session-1",
    userId: "user-1",
    createdAt: new Date("2026-07-29T23:25:00.000Z"),
    expiresAt: new Date("2026-07-30T23:30:00.000Z")
  }]);
  mocks.transaction.mockImplementation(async (callback) => callback({
    $executeRaw: mocks.policyLock,
    $queryRaw: (...args: unknown[]) => {
      const query = Array.isArray(args[0]) ? args[0][0] : "";
      return typeof query === "string" && query.includes('FROM "Session"')
        ? mocks.sessionLock(...args)
        : mocks.memberLock(...args);
    },
    householdMember: {
      findFirst: mocks.txMemberFindFirst,
      update: mocks.memberUpdate
    },
    invite: { updateMany: mocks.inviteUpdateMany },
    notificationPreference: { deleteMany: mocks.notificationPreferenceDeleteMany },
    pushSubscription: { updateMany: mocks.pushSubscriptionUpdateMany },
    auditEvent: { create: mocks.auditCreate },
    session: { deleteMany: mocks.sessionDeleteMany }
  }));
});

describe("household leave preview", () => {
  it("lists the authenticated user's active and suspended current memberships as leave targets", async () => {
    mocks.memberFindMany.mockResolvedValue([
      membership("parent"),
      { ...membership("caretaker", now), id: "member-suspended", householdId: "household-2", household: { name: "Lake House" } }
    ]);

    await expect(getHouseholdLeaveOptions()).resolves.toEqual([
      {
        householdId: "household-1",
        householdName: "River House",
        membershipId: "member-current",
        role: "parent",
        suspended: false
      },
      {
        householdId: "household-2",
        householdName: "Lake House",
        membershipId: "member-suspended",
        role: "caretaker",
        suspended: true
      }
    ]);
    expect(mocks.memberFindMany).toHaveBeenCalledWith({
      where: { userId: "user-1", deletedAt: null, household: { deletedAt: null } },
      include: { household: { select: { name: true } } },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }]
    });
  });

  it("warns from supported current data without inventing unsupported assignments", async () => {
    mocks.memberFindFirst.mockResolvedValue(membership("admin"));
    mocks.memberCount.mockResolvedValue(0);
    mocks.activityCount.mockResolvedValue(2);
    mocks.inviteCount.mockResolvedValue(1);
    mocks.notificationPreferenceCount.mockResolvedValue(3);
    mocks.pushSubscriptionCount.mockResolvedValue(1);

    await expect(getHouseholdLeavePreview("household-1")).resolves.toEqual({
      householdId: "household-1",
      householdName: "River House",
      membershipId: "member-current",
      role: "admin",
      suspended: false,
      protectedOwner: false,
      warnings: ["sole_admin", "active_timers", "pending_invitations", "notification_authority"]
    });
    expect(mocks.inviteCount).toHaveBeenCalledWith({
      where: {
        householdId: "household-1",
        status: "pending",
        OR: [
          { invitedByUserId: "user-1" },
          { email: { equals: "member@example.test", mode: "insensitive" } }
        ]
      }
    });
  });

  it("allows an authenticated suspended member to inspect their own leave consequences", async () => {
    mocks.memberFindFirst.mockResolvedValue(membership("caretaker", now));

    await expect(getHouseholdLeavePreview("household-1")).resolves.toMatchObject({
      membershipId: "member-current",
      suspended: true
    });
  });

  it("does not disclose a household without a current membership owned by the user", async () => {
    mocks.memberFindFirst.mockResolvedValue(null);

    await expect(getHouseholdLeavePreview("household-2")).rejects.toThrow("not_found");
  });
});

describe("self-service household leave", () => {
  it("requires fresh authentication before opening a transaction", async () => {
    mocks.requireFreshSession.mockRejectedValue(new Error("fresh_authentication_required"));

    await expect(leaveHousehold({ householdId: "household-1", confirmation: "River House", operationId }))
      .rejects.toThrow("fresh_authentication_required");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("requires a byte-exact household-name confirmation", async () => {
    await expect(leaveHousehold({ householdId: "household-1", confirmation: " river house ", operationId }))
      .rejects.toThrow("household_leave_confirmation_mismatch");
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
  });

  it("fails closed for the protected household owner", async () => {
    mocks.txMemberFindFirst.mockImplementation(({ where }) =>
      where.leaveOperationId ? null : membership("owner")
    );

    await expect(leaveHousehold({ householdId: "household-1", confirmation: "River House", operationId }))
      .rejects.toThrow("household_owner_cannot_leave");
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["admin", null],
    ["parent", null],
    ["caretaker", null],
    ["read_only", null],
    ["parent", now]
  ])("atomically closes an owned %s membership episode (disabledAt=%s)", async (role, disabledAt) => {
    mocks.txMemberFindFirst.mockImplementation(({ where }) =>
      where.leaveOperationId ? null : membership(role, disabledAt)
    );

    await expect(leaveHousehold({ householdId: "household-1", confirmation: "River House", operationId }))
      .resolves.toEqual({
        operationId,
        householdId: "household-1",
        membershipId: "member-current",
        leftAt: now,
        reason: "self_left"
      });

    expect(mocks.memberUpdate).toHaveBeenCalledWith({
      where: { id: "member-current" },
      data: { deletedAt: now, closureReason: "self_left", leaveOperationId: operationId }
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        householdId: "household-1",
        actorUserId: "user-1",
        actorMemberId: "member-current",
        action: "member.self_leave",
        entityId: "member-current"
      })
    });
  });

  it("revokes only modeled household-scoped authority and preserves global sessions", async () => {
    await leaveHousehold({ householdId: "household-1", confirmation: "River House", operationId });

    expect(mocks.policyLock).toHaveBeenCalledOnce();
    expect(mocks.inviteUpdateMany).toHaveBeenCalledWith({
      where: {
        householdId: "household-1",
        status: "pending",
        OR: [
          { invitedByUserId: "user-1" },
          { email: { equals: "member@example.test", mode: "insensitive" } }
        ]
      },
      data: { status: "revoked", revokedAt: now }
    });
    expect(mocks.notificationPreferenceDeleteMany).toHaveBeenCalledWith({
      where: { householdId: "household-1", userId: "user-1" }
    });
    expect(mocks.pushSubscriptionUpdateMany).toHaveBeenCalledWith({
      where: { householdId: "household-1", userId: "user-1", deletedAt: null },
      data: { deletedAt: now }
    });
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
  });

  it("returns the same completed outcome for a duplicate operation without a second tombstone", async () => {
    const completed = {
      ...membership(),
      deletedAt: now,
      closureReason: "self_left",
      leaveOperationId: operationId
    };
    mocks.txMemberFindFirst.mockImplementation(({ where }) =>
      where.leaveOperationId ? completed : null
    );

    await expect(leaveHousehold({ householdId: "household-1", confirmation: "River House", operationId }))
      .resolves.toEqual({
        operationId,
        householdId: "household-1",
        membershipId: "member-current",
        leftAt: now,
        reason: "self_left"
      });
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("does not alter global identity or another household membership", async () => {
    await leaveHousehold({ householdId: "household-1", confirmation: "River House", operationId });

    expect(mocks.memberUpdate).toHaveBeenCalledOnce();
    expect(mocks.memberUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "member-current" } }));
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.transaction.mock.calls)).not.toContain("household-2");
  });
});

describe("household leave migration contract", () => {
  it("persists an explicit reason and unique stable operation identity on the closed episode", () => {
    const migrationUrl = new URL(
      "../../../prisma/migrations/20260729231500_self_service_household_leave/migration.sql",
      import.meta.url
    );
    const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);

    expect(existsSync(migrationUrl)).toBe(true);
    const migration = readFileSync(migrationUrl, "utf8");
    const schema = readFileSync(schemaUrl, "utf8");

    expect(schema).toMatch(/closureReason\s+String\?/);
    expect(schema).toMatch(/leaveOperationId\s+String\?\s+@unique/);
    expect(migration).toContain('ADD COLUMN "closureReason" TEXT');
    expect(migration).toContain('ADD COLUMN "leaveOperationId" TEXT');
    expect(migration).toContain('CREATE UNIQUE INDEX "HouseholdMember_leaveOperationId_key"');
    expect(migration).not.toMatch(/UPDATE|DELETE\s+FROM\s+"HouseholdMember"/i);
  });
});
