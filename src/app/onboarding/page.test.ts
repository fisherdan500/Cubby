import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHouseholdHome: vi.fn(),
  getHouseholdLeaveOptions: vi.fn(),
  isPlatformOwner: vi.fn(),
  getAppRegistrationPolicy: vi.fn(),
  redirect: vi.fn()
}));

globalThis.React = React;

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/forms/onboarding-form", () => ({
  OnboardingForm: () => React.createElement("form", { "data-testid": "onboarding-form" })
}));
vi.mock("@/components/brand", () => ({
  BrandLockup: () => React.createElement("div", null, "Cubby")
}));
vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/households", () => ({
  getHouseholdHome: mocks.getHouseholdHome
}));
vi.mock("@/server/services/household-leave", () => ({
  getHouseholdLeaveOptions: mocks.getHouseholdLeaveOptions
}));
vi.mock("@/server/services/platform-authority", () => ({ isPlatformOwner: mocks.isPlatformOwner }));
vi.mock("@/server/services/registration", () => ({
  getAppRegistrationPolicy: mocks.getAppRegistrationPolicy
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getHouseholdHome.mockResolvedValue(null);
  mocks.getHouseholdLeaveOptions.mockResolvedValue([]);
  mocks.isPlatformOwner.mockResolvedValue(false);
  mocks.getAppRegistrationPolicy.mockResolvedValue({ newHouseholdCreationAllowed: true });
});

describe("OnboardingPage", () => {
  it("redirects a suspended-only non-owner to the self-leave flow after normal sign-in", async () => {
    mocks.requireUserPage.mockResolvedValue({
      id: "suspended-user",
      email: "member@example.test",
      emailVerified: true,
      name: "Member"
    });
    mocks.getHouseholdLeaveOptions.mockResolvedValue([
      {
        householdId: "household-suspended",
        householdName: "River House",
        membershipId: "member-suspended",
        role: "parent",
        suspended: true
      }
    ]);
    const OnboardingPage = (await import("@/app/onboarding/page")).default;

    await OnboardingPage();

    expect(mocks.redirect).toHaveBeenCalledWith("/app/settings/leave?householdId=household-suspended");
  });

  it("does not offer household creation to an unverified account", async () => {
    mocks.requireUserPage.mockResolvedValue({
      id: "unverified-user",
      email: "parent@example.test",
      emailVerified: false,
      name: "Parent"
    });
    const OnboardingPage = (await import("@/app/onboarding/page")).default;

    const html = renderToStaticMarkup(await OnboardingPage());

    expect(html).toContain("Verify your email before creating a household.");
    expect(html).toContain("Your email address must be verified before you can create a household.");
    expect(html).not.toContain('data-testid="onboarding-form"');
  });
});
