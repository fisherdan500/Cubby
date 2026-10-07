import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  listHouseholdsForUser: vi.fn(),
  getHouseholdLeaveOptions: vi.fn(),
  isPlatformOwner: vi.fn(),
  getAppRegistrationPolicy: vi.fn(),
  currentInvitationSetupCorridor: vi.fn(),
  redirect: vi.fn()
}));

globalThis.React = React;

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/components/forms/onboarding-form", () => ({
  OnboardingForm: ({ canRestore }: { canRestore?: boolean }) => React.createElement("form", { "data-testid": "onboarding-form", "data-can-restore": canRestore ? "yes" : "no" })
}));
vi.mock("@/components/brand", () => ({
  BrandLockup: () => React.createElement("div", null, "Cubby")
}));
vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/households", () => ({
  listHouseholdsForUser: mocks.listHouseholdsForUser
}));
vi.mock("@/server/services/household-leave", () => ({
  getHouseholdLeaveOptions: mocks.getHouseholdLeaveOptions
}));
vi.mock("@/server/services/platform-authority", () => ({ isPlatformOwner: mocks.isPlatformOwner }));
vi.mock("@/server/services/registration", () => ({
  getAppRegistrationPolicy: mocks.getAppRegistrationPolicy
}));
vi.mock("@/server/services/invitation-setup-corridor", () => ({ currentInvitationSetupCorridor: mocks.currentInvitationSetupCorridor }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.listHouseholdsForUser.mockResolvedValue([]);
  mocks.getHouseholdLeaveOptions.mockResolvedValue([]);
  mocks.isPlatformOwner.mockResolvedValue(false);
  mocks.getAppRegistrationPolicy.mockResolvedValue({ platformOwnerBound: true, newHouseholdCreationAllowed: true });
  mocks.currentInvitationSetupCorridor.mockResolvedValue({ result: "ordinary" });
});

describe("OnboardingPage", () => {
  it.each([
    { owner: false, verified: true, allowed: true, suspended: false },
    { owner: true, verified: false, allowed: true, suspended: false },
    { owner: true, verified: true, allowed: false, suspended: false },
    { owner: true, verified: true, allowed: true, suspended: true }
  ])("does not authorize a restore choice outside the first-owner case: %j", async ({ owner, verified, allowed, suspended }) => {
    mocks.requireUserPage.mockResolvedValue({ id: "user", emailVerified: verified });
    mocks.isPlatformOwner.mockResolvedValue(owner);
    mocks.getAppRegistrationPolicy.mockResolvedValue({ platformOwnerBound: true, newHouseholdCreationAllowed: allowed });
    mocks.getHouseholdLeaveOptions.mockResolvedValue(suspended ? [{ role: "owner", suspended: true }] : []);
    const OnboardingPage = (await import("@/app/onboarding/page")).default;
    expect(renderToStaticMarkup(await OnboardingPage())).not.toContain('data-can-restore="yes"');
  });

  it("redirects an existing active member before rendering onboarding", async () => {
    mocks.requireUserPage.mockResolvedValue({ id: "owner", emailVerified: true });
    mocks.isPlatformOwner.mockResolvedValue(true);
    mocks.listHouseholdsForUser.mockResolvedValue([{ household: { id: "existing" } }]);
    mocks.redirect.mockImplementation(() => { throw new Error("redirect"); });
    const OnboardingPage = (await import("@/app/onboarding/page")).default;
    await expect(OnboardingPage()).rejects.toThrow("redirect");
    expect(mocks.redirect).toHaveBeenCalledWith("/app");
    expect(mocks.getAppRegistrationPolicy).not.toHaveBeenCalled();
  });

  it("offers restore only to the verified current platform owner with open direct creation and no memberships", async () => {
    mocks.requireUserPage.mockResolvedValue({ id: "owner", emailVerified: true });
    mocks.isPlatformOwner.mockResolvedValue(true);
    const OnboardingPage = (await import("@/app/onboarding/page")).default;
    expect(renderToStaticMarkup(await OnboardingPage())).toContain('data-can-restore="yes"');
  });

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
    expect(html).not.toContain('href="/setup"');
  });

  it("points the first account of an unowned install at the setup-code claim", async () => {
    mocks.requireUserPage.mockResolvedValue({
      id: "first-user",
      email: "first@example.test",
      emailVerified: false,
      name: "First"
    });
    mocks.getAppRegistrationPolicy.mockResolvedValue({ platformOwnerBound: false, newHouseholdCreationAllowed: false });
    const OnboardingPage = (await import("@/app/onboarding/page")).default;

    const html = renderToStaticMarkup(await OnboardingPage());

    expect(html).toContain('href="/setup"');
    expect(html).toContain("Finish setup with your setup code");
    expect(html).not.toContain('data-testid="onboarding-form"');
  });
});
