import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission } from "@/domain/roles";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  assertFreshSession: vi.fn(),
  requireFreshSession: vi.fn(),
  writeAudit: vi.fn(),
  memberFindUnique: vi.fn(),
  txMemberFindUnique: vi.fn(),
  memberFindUniqueOrThrow: vi.fn(),
  memberUpdate: vi.fn(),
  memberUpdateMany: vi.fn(),
  sessionDeleteMany: vi.fn(),
  memberLock: vi.fn(),
  sessionLock: vi.fn(),
  transaction: vi.fn(),
  inviteCreate: vi.fn(),
  inviteFindUnique: vi.fn(),
  inviteFindMany: vi.fn(),
  txInviteFindUnique: vi.fn(),
  inviteUpdate: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    householdMember: {
      findUnique: mocks.memberFindUnique,
      findUniqueOrThrow: mocks.memberFindUniqueOrThrow,
      updateMany: mocks.memberUpdateMany,
      update: mocks.memberUpdate
    },
    session: {
      deleteMany: mocks.sessionDeleteMany
    },
    invite: {
      create: mocks.inviteCreate,
      findUnique: mocks.inviteFindUnique,
      findMany: mocks.inviteFindMany,
      update: mocks.inviteUpdate
    },
    $transaction: mocks.transaction
  }
}));

vi.mock("@/server/auth/context", () => ({
  getHouseholdContext: mocks.getHouseholdContext,
  requirePermission: mocks.requirePermission
}));

vi.mock("@/server/auth/session", () => ({
  assertFreshSession: mocks.assertFreshSession,
  requireFreshSession: mocks.requireFreshSession,
  requireUser: vi.fn()
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import {
  createInvite,
  removeMember,
  restoreMember,
  revokeInvite,
  suspendMember,
  updateMemberRole
} from "@/server/services/invites";

describe("household member access management", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getHouseholdContext.mockResolvedValue({
      userId: "user-owner",
      householdId: "household-1",
      memberId: "member-owner",
      role: "owner"
    });
    mocks.inviteFindMany.mockResolvedValue([]);
    mocks.requireFreshSession.mockResolvedValue({ user: { id: "user-owner" }, session: { id: "session-owner", createdAt: new Date() } });
    mocks.requirePermission.mockImplementation((ctx, permission) => {
      if (!hasPermission(ctx.role, permission)) throw new Error("forbidden");
    });
    mocks.memberLock.mockResolvedValue([{ id: "locked" }]);
    mocks.sessionLock.mockResolvedValue([{
      id: "session-owner",
      userId: "user-owner",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    }]);
    mocks.txMemberFindUnique.mockImplementation(({ where }) => {
      if (where.id === "member-owner") return activeMember("member-owner", "owner");
      if (where.id === "member-admin") return activeMember("member-admin", "admin");
      return mocks.memberFindUnique({ where });
    });
    mocks.transaction.mockImplementation(async (callback) =>
      callback({
        $queryRaw: (...args: unknown[]) => {
          const query = Array.isArray(args[0]) ? args[0][0] : "";
          return typeof query === "string" && query.includes('FROM "Session"')
            ? mocks.sessionLock(...args)
            : mocks.memberLock(...args);
        },
        $executeRaw: mocks.memberLock,
        householdMember: {
          findUnique: mocks.txMemberFindUnique,
          findUniqueOrThrow: mocks.memberFindUniqueOrThrow,
          update: mocks.memberUpdate,
          updateMany: mocks.memberUpdateMany
        },
        invite: {
          findUnique: mocks.txInviteFindUnique,
          findMany: mocks.inviteFindMany,
          create: mocks.inviteCreate,
          update: mocks.inviteUpdate
        },
        session: { deleteMany: mocks.sessionDeleteMany },
        auditEvent: { create: vi.fn() }
      })
    );
  });

  it("lets the owner promote a parent to admin", async () => {
    mocks.memberFindUnique.mockResolvedValue(activeMember("member-parent", "parent"));
    mocks.memberUpdate.mockResolvedValue({ ...activeMember("member-parent", "admin"), user: { email: "parent@example.com" } });

    await expect(updateMemberRole("member-parent", { role: "admin" })).resolves.toMatchObject({ role: "admin" });
    expect(mocks.memberUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { role: "admin" } }));
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "member.admin.grant" }),
      expect.objectContaining({ auditEvent: expect.anything() })
    );
  });

  it("lets only the owner issue an admin invite", async () => {
    mocks.inviteCreate.mockResolvedValue({
      id: "invite-admin",
      email: "admin@example.com",
      role: "admin",
      household: { name: "Family" }
    });
    await expect(createInvite({ email: "admin@example.com", role: "admin" })).resolves.toMatchObject({
      role: "admin",
      acceptUrl: expect.stringMatching(/^\/invite\//)
    });

    mocks.getHouseholdContext.mockResolvedValue(adminContext());
    await expect(createInvite({ email: "other@example.com", role: "admin" })).rejects.toThrow("forbidden");
  });

  it("prevents an admin from granting admin access", async () => {
    mocks.getHouseholdContext.mockResolvedValue(adminContext());
    mocks.memberFindUnique.mockResolvedValue(activeMember("member-parent", "parent"));

    await expect(updateMemberRole("member-parent", { role: "admin" })).rejects.toThrow("forbidden");
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
  });

  it("preserves a suspended member's role until access is restored", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      ...activeMember("member-parent", "parent"),
      disabledAt: new Date("2026-07-14T12:00:00.000Z")
    });

    await expect(updateMemberRole("member-parent", { role: "caretaker" })).rejects.toThrow("forbidden");
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
  });

  it("prevents admins from changing or removing protected roles", async () => {
    mocks.getHouseholdContext.mockResolvedValue(adminContext());
    mocks.memberFindUnique.mockResolvedValue(activeMember("member-admin-2", "admin"));

    await expect(updateMemberRole("member-admin-2", { role: "parent" })).rejects.toThrow("forbidden");
    await expect(removeMember("member-admin-2")).rejects.toThrow("forbidden");

    mocks.memberFindUnique.mockResolvedValue(activeMember("member-owner", "owner"));
    await expect(removeMember("member-owner")).rejects.toThrow("forbidden");
  });

  it("lets an admin manage a lower access role", async () => {
    mocks.getHouseholdContext.mockResolvedValue(adminContext());
    mocks.memberFindUnique.mockResolvedValue(activeMember("member-care", "caretaker"));
    mocks.memberUpdate.mockResolvedValue({ ...activeMember("member-care", "parent"), user: { email: "care@example.com" } });

    await expect(updateMemberRole("member-care", { role: "parent" })).resolves.toMatchObject({ role: "parent" });
  });

  it("authorizes suspension from the target role locked inside the transaction", async () => {
    mocks.getHouseholdContext.mockResolvedValue(adminContext());
    const staleParent = activeMember("member-target", "parent");
    mocks.memberFindUnique.mockResolvedValue(staleParent);
    mocks.txMemberFindUnique
      .mockResolvedValueOnce(activeMember("member-admin", "admin"))
      .mockResolvedValueOnce(activeMember("member-target", "admin"));
    mocks.memberUpdateMany.mockResolvedValue({ count: 1 });
    mocks.memberFindUniqueOrThrow.mockResolvedValue({ ...staleParent, disabledAt: new Date(), user: {} });

    await expect(suspendMember(staleParent.id)).rejects.toThrow("forbidden");
    expect(mocks.memberLock).toHaveBeenCalledOnce();
    expect(mocks.memberUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects a role change when the locked target is already suspended", async () => {
    const staleActive = activeMember("member-parent", "parent");
    mocks.memberFindUnique.mockResolvedValue(staleActive);
    mocks.txMemberFindUnique
      .mockResolvedValueOnce(activeMember("member-owner", "owner"))
      .mockResolvedValueOnce({ ...staleActive, disabledAt: new Date("2026-07-14T12:00:00.000Z") });
    mocks.memberUpdate.mockResolvedValue({ ...staleActive, role: "caretaker", user: {} });

    await expect(updateMemberRole(staleActive.id, { role: "caretaker" })).rejects.toThrow("forbidden");
    expect(mocks.memberLock).toHaveBeenCalledOnce();
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
  });

  it("denies parents before member data is read", async () => {
    mocks.getHouseholdContext.mockResolvedValue({ ...adminContext(), role: "parent" });

    await expect(updateMemberRole("member-care", { role: "caretaker" })).rejects.toThrow("forbidden");
    expect(mocks.memberFindUnique).not.toHaveBeenCalled();
  });

  it("soft deletes lower access members and preserves their record", async () => {
    mocks.getHouseholdContext.mockResolvedValue(adminContext());
    mocks.memberFindUnique.mockResolvedValue(activeMember("member-care", "caretaker"));
    mocks.memberUpdate.mockResolvedValue({ ...activeMember("member-care", "caretaker"), deletedAt: new Date(), user: { email: "care@example.com" } });

    await removeMember("member-care");
    expect(mocks.memberUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { deletedAt: expect.any(Date) } }));
  });

  it("requires a suspended member to be restored before removal", async () => {
    mocks.getHouseholdContext.mockResolvedValue(adminContext());
    const member = activeMember("member-care", "caretaker");
    mocks.memberFindUnique.mockResolvedValue(member);
    mocks.txMemberFindUnique
      .mockResolvedValueOnce(activeMember("member-admin", "admin"))
      .mockResolvedValueOnce({ ...member, disabledAt: new Date("2026-07-14T12:00:00.000Z") });

    await expect(removeMember(member.id)).rejects.toThrow("forbidden");

    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("returns forbidden for cross-household member and invite operations", async () => {
    mocks.memberFindUnique.mockResolvedValue({ ...activeMember("member-other", "parent"), householdId: "household-2" });
    await expect(updateMemberRole("member-other", { role: "caretaker" })).rejects.toThrow("forbidden");

    mocks.txInviteFindUnique.mockResolvedValue({
      id: "invite-other",
      householdId: "household-2",
      role: "parent",
      status: "pending"
    });
    await expect(revokeInvite("invite-other")).rejects.toThrow("forbidden");
  });

  it("rechecks the revoker's active authority under lock before reading the invite", async () => {
    mocks.txMemberFindUnique.mockResolvedValueOnce({
      ...activeMember("member-owner", "owner"),
      disabledAt: new Date("2026-07-26T12:00:00.000Z")
    });

    await expect(revokeInvite("invite-1")).rejects.toThrow("forbidden");

    expect(mocks.memberLock).toHaveBeenCalledTimes(2);
    expect(mocks.txInviteFindUnique).not.toHaveBeenCalled();
    expect(mocks.inviteUpdate).not.toHaveBeenCalled();
  });

  it("atomically suspends a manageable member, revokes every session, and audits the lifecycle", async () => {
    const member = activeMember("member-admin-2", "admin");
    const disabledAt = new Date("2026-07-14T12:00:00.000Z");
    mocks.memberFindUnique.mockResolvedValue(member);
    mocks.memberUpdate.mockResolvedValue({ ...member, disabledAt, user: { email: "admin@example.com" } });
    mocks.sessionDeleteMany.mockResolvedValue({ count: 2 });

    await expect(suspendMember(member.id, disabledAt)).resolves.toMatchObject({ disabledAt });

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.memberUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: member.id },
      data: { disabledAt }
    }));
    expect(mocks.sessionDeleteMany).toHaveBeenCalledWith({ where: { userId: member.userId } });
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "member.suspend",
        entityId: member.id,
        before: expect.objectContaining({ disabledAt: null, role: "admin", userId: member.userId }),
        after: expect.objectContaining({ disabledAt })
      }),
      expect.objectContaining({ auditEvent: expect.anything() })
    );
  });

  it("prevents suspending the protected owner or acting member", async () => {
    mocks.memberFindUnique.mockResolvedValue(activeMember("member-owner", "owner"));
    await expect(suspendMember("member-owner")).rejects.toThrow("forbidden");

    mocks.memberFindUnique.mockResolvedValue(activeMember("member-owner", "admin"));
    await expect(suspendMember("member-owner")).rejects.toThrow("forbidden");

    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
  });

  it("lets admins suspend lower roles but not admins", async () => {
    mocks.getHouseholdContext.mockResolvedValue(adminContext());
    const caretaker = activeMember("member-care", "caretaker");
    mocks.memberFindUnique.mockResolvedValue(caretaker);
    mocks.memberUpdate.mockResolvedValue({ ...caretaker, disabledAt: new Date(), user: {} });

    await expect(suspendMember(caretaker.id)).resolves.toMatchObject({ id: caretaker.id });

    mocks.memberFindUnique.mockResolvedValue(activeMember("member-admin-2", "admin"));
    await expect(suspendMember("member-admin-2")).rejects.toThrow("forbidden");
  });

  it("rejects cross-household suspension before mutating data", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      ...activeMember("member-other", "parent"),
      householdId: "household-2"
    });

    await expect(suspendMember("member-other")).rejects.toThrow("forbidden");
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
  });

  it("restores the preserved membership and audits without creating a session", async () => {
    const disabledAt = new Date("2026-07-14T12:00:00.000Z");
    const member = { ...activeMember("member-parent", "parent"), disabledAt };
    mocks.memberFindUnique.mockResolvedValue(member);
    mocks.memberUpdate.mockResolvedValue({ ...member, disabledAt: null, user: {} });

    await expect(restoreMember(member.id)).resolves.toMatchObject({ disabledAt: null, role: "parent" });

    expect(mocks.memberUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: member.id },
      data: { disabledAt: null }
    }));
    expect(mocks.sessionDeleteMany).not.toHaveBeenCalled();
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "member.restore", before: expect.objectContaining({ disabledAt }) }),
      expect.objectContaining({ auditEvent: expect.anything() })
    );
  });

  it("does not duplicate lifecycle writes when the requested state already exists", async () => {
    const disabled = { ...activeMember("member-parent", "parent"), disabledAt: new Date() };
    mocks.memberFindUnique.mockResolvedValue(disabled);
    await expect(suspendMember(disabled.id)).resolves.toBe(disabled);

    const active = activeMember("member-parent", "parent");
    mocks.memberFindUnique.mockResolvedValue(active);
    await expect(restoreMember(active.id)).resolves.toBe(active);

    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("records one suspension transition under concurrent duplicate requests", async () => {
    const member = activeMember("member-parent", "parent");
    const disabledAt = new Date("2026-07-14T12:00:00.000Z");
    const suspended = { ...member, disabledAt, user: {} };
    mocks.memberFindUnique.mockResolvedValue(member);
    let targetReads = 0;
    mocks.txMemberFindUnique.mockImplementation(({ where }) => {
      if (where.id === "member-owner") return activeMember("member-owner", "owner");
      targetReads += 1;
      return targetReads === 1 ? member : suspended;
    });
    mocks.memberUpdate.mockResolvedValue(suspended);

    await expect(Promise.all([suspendMember(member.id, disabledAt), suspendMember(member.id, disabledAt)])).resolves.toEqual([
      suspended,
      suspended
    ]);

    expect(mocks.sessionDeleteMany).toHaveBeenCalledOnce();
    expect(mocks.writeAudit).toHaveBeenCalledOnce();
  });
});

function adminContext() {
  return {
    userId: "user-admin",
    householdId: "household-1",
    memberId: "member-admin",
    role: "admin"
  };
}

function activeMember(id: string, role: "owner" | "admin" | "parent" | "caretaker" | "read_only") {
  return {
    id,
    userId: `user-${id}`,
    householdId: "household-1",
    role,
    displayName: null,
    joinedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    disabledAt: null,
    deletedAt: null
  };
}
