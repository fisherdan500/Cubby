import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createOnboardingHousehold: vi.fn(),
  selectedMemberId: "" as string,
  memberFindMany: vi.fn(),
  memberFindFirst: vi.fn(),
  requireUser: vi.fn(),
  requireInvitationSetupCorridor: vi.fn()
}));

vi.mock("@/server/services/households", () => ({
  createOnboardingHousehold: mocks.createOnboardingHousehold
}));
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: () => mocks.selectedMemberId ? { value: mocks.selectedMemberId } : undefined
  })
}));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    householdMember: {
      findMany: mocks.memberFindMany,
      findFirst: mocks.memberFindFirst
    }
  }
}));
vi.mock("@/server/auth/session", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/server/services/invitation-setup-corridor", () => ({
  requireInvitationSetupCorridor: mocks.requireInvitationSetupCorridor
}));
vi.mock("@/server/services/assisted-required-change-state", () => ({
  hasOutstandingRequiredChange: vi.fn().mockResolvedValue(false)
}));

import { POST } from "@/app/api/onboarding/route";
import { SELECTED_HOUSEHOLD_MEMBER_COOKIE } from "@/server/auth/context";
import { getHouseholdSelectionState } from "@/server/services/household-selection";

const user = { id: "owner-1", emailVerified: true };
const member = {
  id: "member-1",
  userId: user.id,
  householdId: "household-1",
  role: "owner",
  disabledAt: null,
  deletedAt: null
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.selectedMemberId = "";
  mocks.createOnboardingHousehold.mockResolvedValue({
    household: { id: member.householdId, name: "Recovery Home" },
    memberId: member.id
  });
  mocks.requireUser.mockResolvedValue(user);
  mocks.requireInvitationSetupCorridor.mockResolvedValue({ user });
  mocks.memberFindMany.mockResolvedValue([{
    id: member.id,
    householdId: member.householdId,
    role: member.role,
    household: { name: "Recovery Home", settings: { accentTheme: "sage" } }
  }]);
  mocks.memberFindFirst.mockResolvedValue(member);
});

describe("onboarding household-selection handoff", () => {
  it("makes the newly created recovery target the selected household for the Backups destination", async () => {
    const response = await POST(new Request("https://cubby.example/api/onboarding", {
      method: "POST",
      body: JSON.stringify({ mode: "restore", householdName: "Recovery Home" })
    }));
    const setCookie = response.headers.get("set-cookie") ?? "";
    const match = new RegExp(`${SELECTED_HOUSEHOLD_MEMBER_COOKIE}=([^;]+)`).exec(setCookie);
    expect(match?.[1]).toBe(member.id);

    mocks.selectedMemberId = decodeURIComponent(match![1]);
    await expect(getHouseholdSelectionState()).resolves.toMatchObject({
      status: "selected",
      selected: {
        memberId: member.id,
        householdId: member.householdId,
        householdName: "Recovery Home",
        role: "owner"
      }
    });
  });
});
