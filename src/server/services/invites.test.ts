import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  requireUser: vi.fn(),
  writeAudit: vi.fn(),
  inviteFindUnique: vi.fn(),
  inviteCreate: vi.fn(),
  inviteUpdate: vi.fn(),
  txInviteFindUnique: vi.fn(),
  txInviteCreate: vi.fn(),
  txInviteUpdate: vi.fn(),
  memberFindUnique: vi.fn(),
  txMemberFindUnique: vi.fn(),
  memberCreate: vi.fn(),
  memberUpdate: vi.fn(),
  inviteLock: vi.fn(),
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
vi.mock("@/server/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import { acceptInvite, createInvite, hashInviteToken, revokeInvite } from "@/server/services/invites";

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
  mocks.inviteCreate.mockResolvedValue({ ...pendingInvite(), household: { id: "household-1" } });
  mocks.txInviteCreate.mockResolvedValue({ ...pendingInvite(), household: { id: "household-1" } });
  mocks.inviteUpdate.mockResolvedValue({ id: "invite-1", status: "revoked" });
  mocks.transaction.mockImplementation(async (callback) =>
    callback({
      $queryRaw: mocks.inviteLock,
      $executeRaw: mocks.inviteLock,
      invite: {
        findUnique: mocks.txInviteFindUnique,
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

    expect(mocks.inviteLock).toHaveBeenCalledOnce();
    expect(mocks.inviteLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txInviteFindUnique.mock.invocationCallOrder[0]
    );
    expect(mocks.memberCreate).not.toHaveBeenCalled();
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.txInviteUpdate).not.toHaveBeenCalled();
    expect(mocks.inviteFindUnique).not.toHaveBeenCalled();
  });

  it("does not grant membership when a locked invite expires after acceptance began", async () => {
    mocks.inviteFindUnique.mockResolvedValue(pendingInvite());
    mocks.txInviteFindUnique.mockResolvedValue({
      ...pendingInvite(),
      expiresAt: new Date("2026-07-26T11:59:59.999Z")
    });

    await expect(acceptInvite("invite-token")).rejects.toThrow("not_found");

    expect(mocks.inviteLock).toHaveBeenCalledOnce();
    expect(mocks.memberCreate).not.toHaveBeenCalled();
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.txInviteUpdate).not.toHaveBeenCalled();
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
