import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  isPlatformOwner: vi.fn(),
  getAppRegistrationPolicy: vi.fn(),
  isFirstAccountSetupAvailable: vi.fn(),
  redirect: vi.fn((href: string) => {
    throw new Error(`NEXT_REDIRECT:${href}`);
  })
}));

globalThis.React = React;

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement("a", { href }, children)
}));
vi.mock("@/components/brand", () => ({ BrandLockup: () => React.createElement("div", null, "Cubby") }));
vi.mock("@/components/platform-setup-claim-form", () => ({
  PlatformSetupClaimForm: () => React.createElement("form", { "data-testid": "claim-form" })
}));
vi.mock("@/components/platform-first-account-form", () => ({
  PlatformFirstAccountForm: () => React.createElement("form", { "data-testid": "first-account-form" })
}));
vi.mock("@/server/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/server/services/platform-authority", () => ({ isPlatformOwner: mocks.isPlatformOwner }));
vi.mock("@/server/services/registration", () => ({ getAppRegistrationPolicy: mocks.getAppRegistrationPolicy }));
vi.mock("@/server/services/platform-setup", () => ({ isFirstAccountSetupAvailable: mocks.isFirstAccountSetupAvailable }));

const signedIn = { user: { id: "user-1", email: "owner@example.test" } };

async function render() {
  const PlatformSetupPage = (await import("@/app/setup/page")).default;
  return renderToStaticMarkup(await PlatformSetupPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(null);
  mocks.isPlatformOwner.mockResolvedValue(false);
  mocks.getAppRegistrationPolicy.mockResolvedValue({ platformOwnerBound: false });
  mocks.isFirstAccountSetupAvailable.mockResolvedValue(true);
});

describe("PlatformSetupPage", () => {
  it("offers a fresh install's visitor the first account, bound to the setup code", async () => {
    const markup = await render();

    expect(markup).toContain('data-testid="first-account-form"');
    expect(markup).not.toContain('data-testid="claim-form"');
    expect(markup).toContain("docker compose logs app");
  });

  it("sends a signed-out visitor to sign in once any account exists", async () => {
    mocks.isFirstAccountSetupAvailable.mockResolvedValue(false);

    await expect(render()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("sends a signed-out visitor to sign in once an owner is bound, without checking for accounts", async () => {
    mocks.getAppRegistrationPolicy.mockResolvedValue({ platformOwnerBound: true });

    await expect(render()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(mocks.isFirstAccountSetupAvailable).not.toHaveBeenCalled();
  });

  it("still lets a signed-in account claim with the code", async () => {
    mocks.getSession.mockResolvedValue(signedIn);

    const markup = await render();

    expect(markup).toContain('data-testid="claim-form"');
    expect(markup).not.toContain('data-testid="first-account-form"');
    expect(markup).toContain("owner@example.test");
  });

  it.each([
    [true, "/platform/settings"],
    [false, "/app"]
  ])("sends a signed-in account away once an owner is bound (owner: %s)", async (owner, destination) => {
    mocks.getSession.mockResolvedValue(signedIn);
    mocks.getAppRegistrationPolicy.mockResolvedValue({ platformOwnerBound: true });
    mocks.isPlatformOwner.mockResolvedValue(owner);

    await expect(render()).rejects.toThrow(`NEXT_REDIRECT:${destination}`);
  });
});
