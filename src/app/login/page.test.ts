import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

globalThis.React = React;

vi.mock("@/components/auth/auth-form", () => ({ AuthForm: () => React.createElement("form", null, "Sign in form") }));
vi.mock("@/components/brand", () => ({ BrandLockup: () => React.createElement("span", null, "Cubby") }));
vi.mock("@/components/ui/card", () => ({ Card: ({ children }: { children: React.ReactNode }) => React.createElement("section", null, children) }));
vi.mock("@/server/services/registration", () => ({ extractInviteToken: vi.fn() }));

describe("LoginPage", () => {
  it("makes offline account recovery discoverable without enabling signup", async () => {
    const Page = (await import("@/app/login/page")).default;
    const html = renderToStaticMarkup(await Page({ searchParams: {} }));
    expect(html).toContain('href="/recovery"');
    expect(html).toContain("Use an offline recovery code");
    expect(html).not.toContain('href="/register"');
  });
});
