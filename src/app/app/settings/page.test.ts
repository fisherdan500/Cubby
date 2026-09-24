import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  isPlatformOwner: vi.fn(),
  getAppRegistrationPolicy: vi.fn()
}));

globalThis.React = React;

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => createElement("a", { href }, children)
}));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => createElement("main", null, children)
}));
vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext }));
vi.mock("@/server/services/platform-authority", () => ({ isPlatformOwner: mocks.isPlatformOwner }));
vi.mock("@/server/services/registration", () => ({ getAppRegistrationPolicy: mocks.getAppRegistrationPolicy }));

import SettingsPage from "@/app/app/settings/page";

async function render(role: string) {
  mocks.getEffectiveHouseholdContext.mockResolvedValue({ role });
  return renderToStaticMarkup(await SettingsPage({ searchParams: {} }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUserPage.mockResolvedValue({ id: "user-1", name: "Avery" });
  mocks.isPlatformOwner.mockResolvedValue(false);
  mocks.getAppRegistrationPolicy.mockResolvedValue({ platformOwnerBound: true });
});

describe("SettingsPage", () => {
  it.each(["owner", "read_only"])("links a %s to their own account security and personal appearance", async (role) => {
    const markup = await render(role);

    // These belong to the person, not a household role, and had no link anywhere in the app.
    expect(markup).toContain('href="/account/security"');
    expect(markup).toContain('href="/account/appearance"');
  });
});
