import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireUserPage: vi.fn(), requireSettingsPage: vi.fn(), headingLevel: vi.fn() }));
globalThis.React = React;
vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/auth/page-access", () => ({ requireSettingsPage: mocks.requireSettingsPage }));
vi.mock("@/components/app-shell", () => ({ AppShell: ({ children, title, userName }: { children: React.ReactNode; title: string; userName: string }) => React.createElement("main", { "data-user": userName }, React.createElement("h1", null, title), children) }));
vi.mock("@/components/settings/security-history", () => ({ SecurityHistory: (props: { headingLevel?: 1 | 2 }) => { mocks.headingLevel(props.headingLevel); return React.createElement("section", { "data-testid": "security-history" }, React.createElement(props.headingLevel === 2 ? "h2" : "h1", null, "Security history section")); } }));

beforeEach(() => { vi.resetAllMocks(); mocks.requireUserPage.mockResolvedValue({ id: "global-user", name: "Global User" }); });

describe("SecurityHistoryPage", () => {
  it("uses the global user guard without household settings authority", async () => {
    const Page = (await import("@/app/app/settings/security-history/page")).default;
    const html = renderToStaticMarkup(await Page());
    expect(mocks.requireUserPage).toHaveBeenCalledOnce();
    expect(mocks.requireSettingsPage).not.toHaveBeenCalled();
    expect(html).toContain('data-testid="security-history"');
    expect(mocks.headingLevel).toHaveBeenCalledWith(2);
    expect(html.match(/<h1/g)).toHaveLength(1);
  });
});
