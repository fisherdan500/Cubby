import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireInvitationSetupCorridor: vi.fn(),
  cookieGet: vi.fn(),
  memberFindFirst: vi.fn()
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => ({ get: mocks.cookieGet }))
}));
vi.mock("@/server/services/invitation-setup-corridor", () => ({ requireInvitationSetupCorridor: mocks.requireInvitationSetupCorridor }));
vi.mock("@/lib/db/prisma", () => ({
  prisma: { householdMember: { findFirst: mocks.memberFindFirst } }
}));

import {
  SELECTED_HOUSEHOLD_MEMBER_COOKIE,
  getEffectiveHouseholdContext,
  getHouseholdContext
} from "@/server/auth/context";

const activeMember = {
  id: "member-episode-2",
  householdId: "household-2",
  role: "parent"
};

describe("household request context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireInvitationSetupCorridor.mockResolvedValue({ user: { id: "user-1" } });
    mocks.cookieGet.mockReturnValue({ value: "member-episode-2" });
    mocks.memberFindFirst.mockResolvedValue(activeMember);
  });

  it("resolves an explicit membership episode only when it is current for the session user and household", async () => {
    await expect(getHouseholdContext("member-episode-2")).resolves.toMatchObject({
      memberId: "member-episode-2",
      householdId: "household-2",
      userId: "user-1"
    });

    expect(mocks.memberFindFirst).toHaveBeenCalledWith({
      where: {
        id: "member-episode-2",
        userId: "user-1",
        disabledAt: null,
        deletedAt: null,
        household: { deletedAt: null }
      }
    });
  });

  it("requires an explicit request candidate instead of falling back to any membership", async () => {
    mocks.cookieGet.mockReturnValue(undefined);

    await expect(getEffectiveHouseholdContext()).rejects.toThrow("household_selection_required");

    expect(mocks.cookieGet).toHaveBeenCalledWith(SELECTED_HOUSEHOLD_MEMBER_COOKIE);
    expect(mocks.memberFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a malformed request candidate without querying for another membership", async () => {
    mocks.cookieGet.mockReturnValue({ value: "  " });

    await expect(getEffectiveHouseholdContext()).rejects.toThrow("household_selection_stale");
    expect(mocks.memberFindFirst).not.toHaveBeenCalled();
  });

  it("treats stale, suspended, removed, and foreign candidates identically without fallback", async () => {
    mocks.memberFindFirst.mockResolvedValue(null);

    await expect(getEffectiveHouseholdContext()).rejects.toThrow("household_selection_stale");

    expect(mocks.memberFindFirst).toHaveBeenCalledTimes(1);
    expect(mocks.memberFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "member-episode-2", userId: "user-1" })
    }));
  });

  it("denies a setup or neutral corridor before looking up a household", async () => {
    mocks.requireInvitationSetupCorridor.mockRejectedValue(new Error("invitation_setup_required"));

    await expect(getEffectiveHouseholdContext()).rejects.toThrow("invitation_setup_required");

    expect(mocks.memberFindFirst).not.toHaveBeenCalled();
  });
});
