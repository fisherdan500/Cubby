import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  requireUser: vi.fn(),
  assertFreshSession: vi.fn(),
  requireFreshSession: vi.fn(),
  writeAudit: vi.fn(),
  inviteFindUnique: vi.fn(),
  inviteCreate: vi.fn(),
  inviteUpdate: vi.fn(),
  txInviteFindUnique: vi.fn(),
  txInviteCreate: vi.fn(),
  txInviteUpdate: vi.fn(),
  txInviteFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
  txMemberFindUnique: vi.fn(),
  memberCreate: vi.fn(),
  memberUpdate: vi.fn(),
  inviteLock: vi.fn(),
  sessionLock: vi.fn(),
  recipientUserLock: vi.fn(),
  globalAuditCreate: vi.fn(),
  txAuditCreate: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    invite: {
      findUnique: mocks.inviteFindUnique,
      create: mocks.inviteCreate,
      update: mocks.inviteUpdate
    },
    householdMember: {
      findUnique: mocks.memberFindUnique,
      create: mocks.memberCreate,
      update: mocks.memberUpdate
    },
    auditEvent: { create: mocks.globalAuditCreate },
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
  requireUser: mocks.requireUser
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import {
  acceptInvite,
  BULK_INVITE_REVOKE_ACKNOWLEDGEMENT,
  createInvite,
  hashInviteToken,
  resolveInviteMembershipState,
  resolveInviteExpiry,
  revokeAllPendingInvites,
  revokeInvite
} from "@/server/services/invites";

const now = new Date("2026-07-26T12:00:00.000Z");

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.requireUser.mockResolvedValue({
    id: "invited-user",
    name: "Invited User",
    email: "invitee@example.test"
  });
  mocks.requireFreshSession.mockResolvedValue({ user: { id: "owner-user" }, session: { id: "session-owner", createdAt: now } });
  mocks.getHouseholdContext.mockResolvedValue({
    userId: "owner-user",
    householdId: "household-1",
    memberId: "owner-member",
    role: "owner"
  });
  mocks.inviteLock.mockResolvedValue([{ id: "invite-1" }]);
  mocks.memberFindUnique.mockResolvedValue(null);
  mocks.txMemberFindUnique.mockImplementation(({ where }) =>
    where.id === "owner-member"
      ? {
          id: "owner-member",
          userId: "owner-user",
          householdId: "household-1",
          role: "owner",
          disabledAt: null,
          deletedAt: null
        }
      : null
  );
  mocks.memberCreate.mockResolvedValue({
    id: "member-1",
    householdId: "household-1",
    userId: "invited-user",
    role: "parent"
  });
  mocks.memberUpdate.mockResolvedValue({ id: "member-1" });
  mocks.txInviteUpdate.mockResolvedValue({ id: "invite-1", status: "accepted" });
  mocks.txInviteFindMany.mockResolvedValue([]);
  mocks.inviteCreate.mockResolvedValue({ ...pendingInvite(), household: { id: "household-1" } });
  mocks.txInviteCreate.mockResolvedValue({ ...pendingInvite(), household: { id: "household-1" } });
  mocks.inviteUpdate.mockResolvedValue({ id: "invite-1", status: "revoked" });
  mocks.sessionLock.mockResolvedValue([{
    id: "session-owner",
    userId: "owner-user",
    createdAt: now,
    expiresAt: new Date("2026-07-27T13:00:00.000Z")
  }]);
  mocks.recipientUserLock.mockResolvedValue([{
    id: "invited-user",
    email: "invitee@example.test",
    emailVerified: true
  }]);
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      $queryRaw: (...args: unknown[]) => {
        const query = Array.isArray(args[0]) ? args[0][0] : "";
        return typeof query === "string" && query.includes('FROM "Session"')
          ? mocks.sessionLock(...args)
          : typeof query === "string" && query.includes('FROM "User"')
            ? mocks.recipientUserLock(...args)
          : mocks.inviteLock(...args);
      },
      $executeRaw: mocks.inviteLock,
      invite: {
        findUnique: mocks.txInviteFindUnique,
        findMany: mocks.txInviteFindMany,
        create: mocks.txInviteCreate,
        update: mocks.txInviteUpdate
      },
      householdMember: {
        findUnique: mocks.txMemberFindUnique,
        create: mocks.memberCreate,
        update: mocks.memberUpdate
      },
      auditEvent: { create: mocks.txAuditCreate }
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("invite token hashing", () => {
  it("is deterministic and does not preserve the raw token", () => {
    const token = "invite-token";
    expect(hashInviteToken(token)).toBe(hashInviteToken(token));
    expect(hashInviteToken(token)).not.toBe(token);
  });
});

describe("invitation expiry policy", () => {
  it.each([
    ["parent", undefined, "2026-08-02T12:00:00.000Z"],
    ["parent", 1, "2026-07-26T13:00:00.000Z"],
    ["parent", 24 * 30, "2026-08-25T12:00:00.000Z"],
    ["admin", undefined, "2026-07-27T12:00:00.000Z"],
    ["admin", 1, "2026-07-26T13:00:00.000Z"],
    ["admin", 24 * 7, "2026-08-02T12:00:00.000Z"]
  ])("uses the role-sensitive allowed expiry for %s", (role, hours, expected) => {
    expect(resolveInviteExpiry(role as "admin" | "parent", hours)).toEqual(new Date(expected));
  });

  it.each([
    ["parent", 0],
    ["parent", 24 * 30 + 1],
    ["admin", 0],
    ["admin", 24 * 7 + 1]
  ])("rejects an expiry outside the %s invitation range", (role, hours) => {
    expect(() => resolveInviteExpiry(role as "admin" | "parent", hours)).toThrow("invite_expiry_invalid");
  });

  it("persists the requested allowed expiry when creating an invitation", async () => {
    await createInvite({ email: "new@example.test", role: "parent", expiresInHours: 48 });

    expect(mocks.txInviteCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ expiresAt: new Date("2026-07-28T12:00:00.000Z") })
    }));
  });
});

describe("invitation rotation", () => {
  it("revokes and audits every locked pending link for the recipient before issuing one replacement", async () => {
    mocks.txInviteFindMany.mockResolvedValue([
      { ...pendingInvite(), id: "invite-old-a" },
      { ...pendingInvite(), id: "invite-old-b" }
    ]);

    const result = await createInvite({ email: "INVITEE@example.test", role: "parent" });

    expect(mocks.txInviteUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "invite-old-a" },
      data: expect.objectContaining({ status: "revoked" })
    }));
    expect(mocks.txInviteUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "invite-old-b" },
      data: expect.objectContaining({ status: "revoked" })
    }));
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "invite.rotate", entityId: "invite-old-a" }),
      expect.anything()
    );
    expect(mocks.txInviteCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ email: "invitee@example.test" })
    }));
    expect(result.acceptUrl).toMatch(/^\/invite\//);
    expect(JSON.stringify(mocks.txInviteCreate.mock.calls)).not.toContain(result.acceptUrl);
  });

  it("requires a fresh owner session before issuing or rotating an admin invitation", async () => {
    await createInvite({ email: "admin@example.test", role: "admin" });

    expect(mocks.requireFreshSession).toHaveBeenCalledOnce();
  });

  it("fails closed when the fresh session belongs to a different user", async () => {
    mocks.requireFreshSession.mockResolvedValue({ user: { id: "other-user" }, session: { createdAt: now } });

    await expect(createInvite({ email: "admin@example.test", role: "admin" })).rejects.toThrow("forbidden");

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("fails closed when the fresh session is revoked while awaiting the locks", async () => {
    mocks.sessionLock.mockResolvedValue([]);

    await expect(createInvite({ email: "admin@example.test", role: "admin" })).rejects.toThrow("unauthenticated");

    expect(mocks.txInviteCreate).not.toHaveBeenCalled();
  });
});

describe("membership-state matrix", () => {
  const role = "parent" as const;

  it.each([
    ["absent", null, "absent"],
    ["active same role", { role, disabledAt: null, deletedAt: null }, "active_same_role"],
    ["active different role", { role: "caretaker", disabledAt: null, deletedAt: null }, "active_role_conflict"],
    ["suspended same role", { role, disabledAt: now, deletedAt: null }, "suspended"],
    ["suspended different role", { role: "caretaker", disabledAt: now, deletedAt: null }, "suspended"],
    ["removed", { role: "caretaker", disabledAt: null, deletedAt: now }, "removed"]
  ])("classifies %s explicitly", (_label, member, expected) => {
    expect(resolveInviteMembershipState(
      member as Parameters<typeof resolveInviteMembershipState>[0],
      role
    )).toBe(expected);
  });
});

describe("invite consumption serialization", () => {
  it("does not issue an invite after the issuer was suspended during the request", async () => {
    mocks.txMemberFindUnique.mockResolvedValue({
      id: "owner-member",
      userId: "owner-user",
      householdId: "household-1",
      role: "owner",
      disabledAt: new Date(),
      deletedAt: null
    });

    await expect(createInvite({ email: "new@example.test", role: "parent" })).rejects.toThrow("forbidden");

    expect(mocks.txInviteCreate).not.toHaveBeenCalled();
    expect(mocks.inviteCreate).not.toHaveBeenCalled();
  });

  it("does not grant membership when a locked invite was revoked after acceptance began", async () => {
    mocks.inviteFindUnique.mockResolvedValue(pendingInvite());
    mocks.txInviteFindUnique.mockResolvedValue({ ...pendingInvite(), status: "revoked" });

    await expect(acceptInvite("invite-token")).rejects.toThrow("not_found");

    expect(mocks.inviteLock).toHaveBeenCalledTimes(2);
    expect(mocks.inviteLock.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.txInviteFindUnique.mock.invocationCallOrder[0]
    );
    expect(mocks.memberCreate).not.toHaveBeenCalled();
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.txInviteUpdate).not.toHaveBeenCalled();
    expect(mocks.inviteFindUnique).not.toHaveBeenCalled();
  });

  it("closes a role-conflicting active membership invitation without changing the membership", async () => {
    mocks.txInviteFindUnique.mockResolvedValue(pendingInvite());
    mocks.txMemberFindUnique.mockImplementation(({ where }) =>
      where.id === "owner-member"
        ? {
            id: "owner-member",
            userId: "owner-user",
            householdId: "household-1",
            role: "owner",
            disabledAt: null,
            deletedAt: null
          }
        : {
            id: "existing-member",
            householdId: "household-1",
            userId: "invited-user",
            role: "caretaker",
            disabledAt: null,
            deletedAt: null
          }
    );

    await expect(acceptInvite("invite-token")).rejects.toThrow("invite_membership_conflict");

    expect(mocks.memberCreate).not.toHaveBeenCalled();
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.txInviteUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "conflicted" })
    }));
  });

  it("closes an invitation for a suspended membership without restoring access", async () => {
    mocks.txInviteFindUnique.mockResolvedValue(pendingInvite());
    mocks.txMemberFindUnique.mockResolvedValue({
      id: "existing-member",
      householdId: "household-1",
      userId: "invited-user",
      role: "parent",
      disabledAt: now,
      deletedAt: null
    });

    await expect(acceptInvite("invite-token")).rejects.toThrow("invite_membership_conflict");

    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.txInviteUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "conflicted" }
    }));
    expect(mocks.txAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ after: { reason: "suspended" } })
    }));
  });

  it("restores a removed membership with the invited role", async () => {
    mocks.txInviteFindUnique.mockResolvedValue(pendingInvite());
    mocks.txMemberFindUnique.mockResolvedValue({
      id: "existing-member",
      householdId: "household-1",
      userId: "invited-user",
      role: "caretaker",
      disabledAt: now,
      deletedAt: now
    });
    mocks.memberUpdate.mockResolvedValue({
      id: "existing-member",
      householdId: "household-1",
      userId: "invited-user",
      role: "parent"
    });

    await expect(acceptInvite("invite-token")).resolves.toMatchObject({ id: "existing-member" });
    expect(mocks.memberUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { role: "parent", disabledAt: null, deletedAt: null }
    }));
  });

  it("uses the same not-found result for a mismatched recipient", async () => {
    mocks.txInviteFindUnique.mockResolvedValue(pendingInvite());
    mocks.requireUser.mockResolvedValue({
      id: "other-user",
      name: "Other",
      email: "other@example.test"
    });
    mocks.recipientUserLock.mockResolvedValue([{
      id: "other-user",
      email: "other@example.test",
      emailVerified: true
    }]);

    await expect(acceptInvite("invite-token")).rejects.toThrow("not_found");
    expect(mocks.memberCreate).not.toHaveBeenCalled();
  });

  it("does not grant membership to an unverified recipient after locking their user record", async () => {
    mocks.txInviteFindUnique.mockResolvedValue(pendingInvite());
    mocks.recipientUserLock.mockResolvedValue([{
      id: "invited-user",
      email: "invitee@example.test",
      emailVerified: false
    }]);

    await expect(acceptInvite("invite-token")).rejects.toThrow("not_found");

    expect(mocks.recipientUserLock).toHaveBeenCalledOnce();
    expect(mocks.memberCreate).not.toHaveBeenCalled();
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.txInviteUpdate).not.toHaveBeenCalled();
  });

  it("does not grant membership when a locked invite expires after acceptance began", async () => {
    mocks.inviteFindUnique.mockResolvedValue(pendingInvite());
    mocks.txInviteFindUnique.mockResolvedValue({
      ...pendingInvite(),
      expiresAt: new Date("2026-07-26T11:59:59.999Z")
    });

    await expect(acceptInvite("invite-token")).rejects.toThrow("not_found");

    expect(mocks.inviteLock).toHaveBeenCalledTimes(2);
    expect(mocks.memberCreate).not.toHaveBeenCalled();
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.txInviteUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "invite-1" },
      data: expect.objectContaining({ status: "expired" })
    }));
    expect(mocks.txAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "invite.expire", entityId: "invite-1" })
    }));
    expect(mocks.inviteFindUnique).not.toHaveBeenCalled();
  });

  it("writes the acceptance audit event inside the membership and invitation transaction", async () => {
    mocks.txInviteFindUnique.mockResolvedValue(pendingInvite());

    await expect(acceptInvite("invite-token")).resolves.toMatchObject({ id: "member-1" });

    expect(mocks.txInviteUpdate).toHaveBeenCalledOnce();
    expect(mocks.txAuditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "invite.accept",
        entityId: "invite-1",
        actorMemberId: "member-1"
      })
    }));
    expect(mocks.txInviteUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txAuditCreate.mock.invocationCallOrder[0]
    );
    expect(mocks.globalAuditCreate).not.toHaveBeenCalled();
  });

  it("does not overwrite an invite accepted while revocation was waiting for its row lock", async () => {
    mocks.inviteFindUnique.mockResolvedValue({ ...pendingInvite(), status: "pending" });
    mocks.txMemberFindUnique.mockResolvedValue({
      id: "owner-member",
      userId: "owner-user",
      householdId: "household-1",
      role: "owner",
      disabledAt: null,
      deletedAt: null
    });
    mocks.txInviteFindUnique.mockResolvedValue({ ...pendingInvite(), status: "accepted" });

    await expect(revokeInvite("invite-1")).rejects.toThrow("not_found");

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.inviteLock).toHaveBeenCalledTimes(3);
    expect(mocks.inviteLock.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.txInviteFindUnique.mock.invocationCallOrder[0]
    );
    expect(mocks.inviteUpdate).not.toHaveBeenCalled();
    expect(mocks.txInviteUpdate).not.toHaveBeenCalled();
  });
});

describe("owner emergency invitation revocation", () => {
  it("requires the byte-exact acknowledgement before session or database access", async () => {
    await expect(revokeAllPendingInvites({
      acknowledgement: ` ${BULK_INVITE_REVOKE_ACKNOWLEDGEMENT}`
    })).rejects.toThrow("bulk_invite_revoke_acknowledgement_required");

    expect(mocks.requireFreshSession).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("requires a fresh session", async () => {
    mocks.requireFreshSession.mockRejectedValue(new Error("fresh_authentication_required"));

    await expect(revokeAllPendingInvites({
      acknowledgement: BULK_INVITE_REVOKE_ACKNOWLEDGEMENT
    })).rejects.toThrow("fresh_authentication_required");

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rechecks freshness after obtaining the operation locks", async () => {
    mocks.sessionLock.mockResolvedValue([{
      id: "session-owner",
      userId: "owner-user",
      createdAt: new Date("2026-07-26T11:50:00.000Z"),
      expiresAt: new Date("2026-07-27T13:00:00.000Z")
    }]);

    await expect(revokeAllPendingInvites({
      acknowledgement: BULK_INVITE_REVOKE_ACKNOWLEDGEMENT
    })).rejects.toThrow("fresh_authentication_required");

    expect(mocks.txInviteUpdate).not.toHaveBeenCalled();
  });

  it("fails closed for a non-owner after locking and re-reading the actor", async () => {
    mocks.txMemberFindUnique.mockResolvedValue({
      id: "owner-member",
      userId: "owner-user",
      householdId: "household-1",
      role: "admin",
      disabledAt: null,
      deletedAt: null
    });

    await expect(revokeAllPendingInvites({
      acknowledgement: BULK_INVITE_REVOKE_ACKNOWLEDGEMENT
    })).rejects.toThrow("forbidden");

    expect(mocks.txInviteUpdate).not.toHaveBeenCalled();
  });

  it("revokes locked pending invitations with per-invite and aggregate audits", async () => {
    mocks.txInviteFindMany.mockResolvedValue([
      { ...pendingInvite(), id: "invite-a" },
      { ...pendingInvite(), id: "invite-b" }
    ]);

    await expect(revokeAllPendingInvites({
      acknowledgement: BULK_INVITE_REVOKE_ACKNOWLEDGEMENT
    })).resolves.toEqual({ revokedCount: 2 });

    expect(mocks.txInviteUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "invite.emergency_revoke_all" }),
      expect.anything()
    );
  });

  it("is a no-op without audit records when a retry finds no pending invitations", async () => {
    mocks.inviteLock.mockResolvedValue([]);

    await expect(revokeAllPendingInvites({
      acknowledgement: BULK_INVITE_REVOKE_ACKNOWLEDGEMENT
    })).resolves.toEqual({ revokedCount: 0 });

    expect(mocks.txInviteUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});

function pendingInvite() {
  return {
    id: "invite-1",
    householdId: "household-1",
    email: "invitee@example.test",
    role: "parent",
    status: "pending",
    expiresAt: new Date("2026-07-26T12:00:01.000Z")
  };
}
