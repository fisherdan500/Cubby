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

import {
  ACCOUNT_DISABLED_CODE,
  ACCOUNT_DISABLED_MESSAGE,
  assertUserCanStartSession
} from "@/server/auth/member-status";

describe("member session eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platformAuthorityFindUnique.mockResolvedValue(null);
  });

  it("denies a suspended member with the exact product message", async () => {
    mocks.memberFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "member-disabled" });

    const error = await assertUserCanStartSession({ userId: "user-disabled" }).catch((value) => value);

    expect(error).toMatchObject({
      status: "FORBIDDEN",
      body: { code: ACCOUNT_DISABLED_CODE, message: ACCOUNT_DISABLED_MESSAGE }
    });
    expect(ACCOUNT_DISABLED_MESSAGE).toBe("Your account is disabled.");
    expect(mocks.memberFindFirst).toHaveBeenNthCalledWith(1, {
      where: {
        userId: "user-disabled",
        disabledAt: null,
        deletedAt: null,
        household: { deletedAt: null }
      },
      select: { id: true }
    });
    expect(mocks.memberFindFirst).toHaveBeenNthCalledWith(2, {
      where: {
        userId: "user-disabled",
        disabledAt: { not: null },
        deletedAt: null,
        household: { deletedAt: null }
      },
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
    expect(mocks.memberFindFirst).toHaveBeenCalledTimes(2);
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
