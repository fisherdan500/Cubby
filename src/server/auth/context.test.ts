import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  memberFindFirst: vi.fn()
}));

vi.mock("@/server/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/db/prisma", () => ({
  prisma: { householdMember: { findFirst: mocks.memberFindFirst } }
}));

import { getHouseholdContext } from "@/server/auth/context";

describe("household request context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    mocks.memberFindFirst.mockResolvedValue({
      id: "member-1",
      householdId: "household-1",
      role: "parent"
    });
  });

  it("resolves only non-deleted, non-suspended memberships", async () => {
    await expect(getHouseholdContext("household-1")).resolves.toMatchObject({ memberId: "member-1" });

    expect(mocks.memberFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        userId: "user-1",
        disabledAt: null,
        deletedAt: null,
        household: { deletedAt: null, id: "household-1" }
      }
    }));
  });

  it("fails closed when no active membership is available", async () => {
    mocks.memberFindFirst.mockResolvedValue(null);
    await expect(getHouseholdContext()).rejects.toThrow("not_found");
  });
});
