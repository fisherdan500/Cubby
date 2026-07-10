import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission } from "@/domain/roles";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  writeAudit: vi.fn(),
  memberFindUnique: vi.fn(),
  memberUpdate: vi.fn(),
  inviteCreate: vi.fn(),
  inviteFindUnique: vi.fn(),
  inviteUpdate: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    householdMember: {
      findUnique: mocks.memberFindUnique,
      update: mocks.memberUpdate
    },
    invite: {
      create: mocks.inviteCreate,
      findUnique: mocks.inviteFindUnique,
      update: mocks.inviteUpdate
    }
  }
}));

vi.mock("@/server/auth/context", () => ({
  getHouseholdContext: mocks.getHouseholdContext,
  requirePermission: mocks.requirePermission
}));

vi.mock("@/server/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import { createInvite, removeMember, revokeInvite, updateMemberRole } from "@/server/services/invites";

describe("household member access management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHouseholdContext.mockResolvedValue({
      userId: "user-owner",
      householdId: "household-1",
      memberId: "member-owner",
      role: "owner"
    });
    mocks.requirePermission.mockImplementation((ctx, permission) => {
      if (!hasPermission(ctx.role, permission)) throw new Error("forbidden");
    });
  });

  it("lets the owner promote a parent to admin", async () => {
    mocks.memberFindUnique.mockResolvedValue(activeMember("member-parent", "parent"));
    mocks.memberUpdate.mockResolvedValue({ ...activeMember("member-parent", "admin"), user: { email: "parent@example.com" } });

    await expect(updateMemberRole("member-parent", { role: "admin" })).resolves.toMatchObject({ role: "admin" });
    expect(mocks.memberUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { role: "admin" } }));
    expect(mocks.writeAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "member.admin.grant" }));
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

  it("returns forbidden for cross-household member and invite operations", async () => {
    mocks.memberFindUnique.mockResolvedValue({ ...activeMember("member-other", "parent"), householdId: "household-2" });
    await expect(updateMemberRole("member-other", { role: "caretaker" })).rejects.toThrow("forbidden");

    mocks.inviteFindUnique.mockResolvedValue({
      id: "invite-other",
      householdId: "household-2",
      role: "parent",
      status: "pending"
    });
    await expect(revokeInvite("invite-other")).rejects.toThrow("forbidden");
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
    deletedAt: null
  };
}
