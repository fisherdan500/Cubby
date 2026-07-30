import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  memberFindFirst: vi.fn(),
  platformAuthorityFindUnique: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    householdMember: { findFirst: mocks.memberFindFirst },
    platformAuthority: { findUnique: mocks.platformAuthorityFindUnique }
  }
}));

import { assertUserCanStartSession } from "@/server/auth/member-status";

describe("member session eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platformAuthorityFindUnique.mockResolvedValue(null);
  });

  it("allows a suspended member to establish a session for the separately guarded leave flow", async () => {
    mocks.memberFindFirst.mockResolvedValue(null);

    await expect(assertUserCanStartSession({ userId: "user-disabled" })).resolves.toBeUndefined();
    expect(mocks.memberFindFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-disabled",
        disabledAt: null,
        deletedAt: null,
        household: { deletedAt: null }
      },
      select: { id: true }
    });
    expect(mocks.memberFindFirst).toHaveBeenCalledOnce();
    expect(mocks.platformAuthorityFindUnique).toHaveBeenCalledWith({
      where: { ownerUserId: "user-disabled" },
      select: { id: true }
    });
  });

  it("allows a user with any active membership, including alongside a suspension", async () => {
    mocks.memberFindFirst.mockResolvedValueOnce({ id: "member-active" });

    await expect(assertUserCanStartSession({ userId: "user-active" })).resolves.toBeUndefined();
    expect(mocks.memberFindFirst).toHaveBeenCalledOnce();
  });

  it("allows users who have not joined a household", async () => {
    mocks.memberFindFirst.mockResolvedValue(null);

    await expect(assertUserCanStartSession({ userId: "user-invited" })).resolves.toBeUndefined();
    expect(mocks.memberFindFirst).toHaveBeenCalledOnce();
  });

  it("allows the platform owner to establish a session independently of household suspension", async () => {
    mocks.memberFindFirst.mockResolvedValueOnce(null);
    mocks.platformAuthorityFindUnique.mockResolvedValue({ id: "platform" });

    await expect(assertUserCanStartSession({ userId: "platform-owner" })).resolves.toBeUndefined();
    expect(mocks.platformAuthorityFindUnique).toHaveBeenCalledWith({
      where: { ownerUserId: "platform-owner" },
      select: { id: true }
    });
    expect(mocks.memberFindFirst).toHaveBeenCalledOnce();
  });
});
