import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

globalThis.React = React;

const mocks = vi.hoisted(() => ({ requireUserPage: vi.fn(), accountScope: vi.fn(), sessionScope: vi.fn(), historyHeadingLevel: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/components/account-security-panel", () => ({ AccountSecurityPanel: (props: { accountScope: string }) => { mocks.accountScope(props.accountScope); return React.createElement("section", null, "Credential carrier"); } }));
vi.mock("@/components/settings/session-manager", () => ({ SessionManager: (props: { accountScope: string }) => { mocks.sessionScope(props.accountScope); return React.createElement("section", null, "Session carrier"); } }));
vi.mock("@/components/settings/security-history", () => ({ SecurityHistory: (props: { headingLevel?: 1 | 2 }) => { mocks.historyHeadingLevel(props.headingLevel); return React.createElement("section", null, React.createElement(props.headingLevel === 2 ? "h2" : "h1", null, "History carrier")); } }));

describe("global account security page", () => {
  it("uses only the global user guard and carries credentials, recovery, sessions, and history", async () => {
    mocks.requireUserPage.mockResolvedValue({ id: "user-one", name: "Avery" });
    const Page = (await import("@/app/account/security/page")).default;
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain("Account security");
    expect(html).toContain("Credential carrier");
    expect(html).toContain("Session carrier");
    expect(html).toContain("History carrier");
    expect(mocks.requireUserPage).toHaveBeenCalledOnce();
    expect(mocks.accountScope).toHaveBeenCalledWith("user-one");
    expect(mocks.sessionScope).toHaveBeenCalledWith("user-one");
    expect(mocks.historyHeadingLevel).toHaveBeenCalledWith(2);
    expect(html.match(/<h1/g)).toHaveLength(1);
  });
});
