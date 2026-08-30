import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireUserPage: vi.fn(), requireSettingsPage: vi.fn() }));

globalThis.React = React;

vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/auth/page-access", () => ({ requireSettingsPage: mocks.requireSettingsPage }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children, userName }: { children: React.ReactNode; userName: string }) =>
    React.createElement("main", { "data-user": userName }, children)
}));
vi.mock("@/components/settings/session-manager", () => ({
  SessionManager: () => React.createElement("section", { "data-testid": "session-manager" })
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUserPage.mockResolvedValue({ id: "global-user", name: "Global User" });
});

describe("SessionsPage", () => {
  it("uses the global user guard without requiring household settings authority", async () => {
    const SessionsPage = (await import("@/app/app/settings/sessions/page")).default;

    const html = renderToStaticMarkup(await SessionsPage());

    expect(mocks.requireUserPage).toHaveBeenCalledOnce();
    expect(mocks.requireSettingsPage).not.toHaveBeenCalled();
    expect(html).toContain('data-user="Global User"');
    expect(html).toContain('data-testid="session-manager"');
  });
});
