import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHouseholdLeaveOptions: vi.fn(),
  getHouseholdLeavePreview: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("not_found");
  })
}));

vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/household-leave", () => ({
  getHouseholdLeaveOptions: mocks.getHouseholdLeaveOptions,
  getHouseholdLeavePreview: mocks.getHouseholdLeavePreview
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));

import LeaveHouseholdPage from "@/app/app/settings/leave/page";

globalThis.React = React;

const options = [
  {
    householdId: "household-1",
    householdName: "River House",
    membershipId: "member-active",
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
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.notFound.mockImplementation(() => {
    throw new Error("not_found");
  });
  mocks.requireUserPage.mockResolvedValue({ name: "Member", email: "member@example.test" });
  mocks.getHouseholdLeaveOptions.mockResolvedValue(options);
  mocks.getHouseholdLeavePreview.mockResolvedValue({
    ...options[1],
    protectedOwner: false,
    warnings: []
  });
});

describe("leave household membership targeting", () => {
  it("allows an authenticated user to select their suspended membership explicitly", async () => {
    await LeaveHouseholdPage({ searchParams: { householdId: "household-2" } });

    expect(mocks.getHouseholdLeavePreview).toHaveBeenCalledWith("household-2");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("fails closed when the requested household is not one of the user's current memberships", async () => {
    await expect(LeaveHouseholdPage({ searchParams: { householdId: "household-other" } }))
      .rejects.toThrow("not_found");

    expect(mocks.getHouseholdLeavePreview).not.toHaveBeenCalled();
  });
});
