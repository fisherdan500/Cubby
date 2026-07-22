import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHouseholdHome: vi.fn(),
  isPlatformOwner: vi.fn(),
  getAppRegistrationPolicy: vi.fn()
}));

globalThis.React = React;

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/components/forms/onboarding-form", () => ({
  OnboardingForm: () => React.createElement("form", { "data-testid": "onboarding-form" })
}));
vi.mock("@/components/brand", () => ({
  BrandLockup: () => React.createElement("div", null, "Cubby")
}));
vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/households", () => ({ getHouseholdHome: mocks.getHouseholdHome }));
vi.mock("@/server/services/platform-authority", () => ({ isPlatformOwner: mocks.isPlatformOwner }));
vi.mock("@/server/services/registration", () => ({
  getAppRegistrationPolicy: mocks.getAppRegistrationPolicy
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getHouseholdHome.mockResolvedValue(null);
  mocks.isPlatformOwner.mockResolvedValue(false);
  mocks.getAppRegistrationPolicy.mockResolvedValue({ newHouseholdCreationAllowed: true });
});

describe("OnboardingPage", () => {
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
