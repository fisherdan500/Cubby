// @vitest-environment jsdom
import React, { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.React = React;
vi.mock("@/components/invitations/invitation-browser", () => ({
  invitationOperationId: vi.fn(() => "11111111-1111-4111-8111-111111111111"),
  invitationFingerprint: vi.fn(async (scope: string) => scope.padEnd(64, "0").slice(0, 64))
}));
import { ManualInvitationManager } from "@/components/invitations/manual-invitation-manager";

const response = (data: Record<string, unknown>) => ({ ok: true, json: async () => ({ ok: true, data }) }) as Response;
const props = { invites: [{ id: "invite-1", email: "member@example.test", role: "parent" as const, expiresAt: "2030-01-01T00:00:00.000Z" }], canInviteAdmin: true, isOwner: true };

beforeEach(() => { sessionStorage.clear(); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } }); });
afterEach(() => cleanup());

describe("ManualInvitationManager rendered behavior", () => {
  it("treats revoked receipts as successful and gives revoke feedback in an alert", async () => {
    globalThis.fetch = vi.fn(async () => response({ status: "revoked" }));
    render(createElement(ManualInvitationManager, props));
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Invitation revoked");
  });

  it("offers a focusable display-once copy action without placing its secret in a live announcement", async () => {
    globalThis.fetch = vi.fn(async (_path, init) => response(JSON.parse(String(init?.body)).action === "reserve" ? { status: "prepared" } : { status: "created", displayOnceUrl: "/invite#c=display-once-token" }));
    render(createElement(ManualInvitationManager, { ...props, invites: [] }));
    await userEvent.type(screen.getByLabelText("Recipient email"), "member@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    const secret = await screen.findByRole("region", { name: "Display-once invitation link" });
    expect(secret.getAttribute("aria-live")).toBe("off");
    const copy = screen.getByRole("button", { name: "Copy invitation link" });
    await userEvent.click(copy);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("display-once-token"));
  });
});

describe("ManualInvitationManager contract", () => {
  it("uses reviewed issuer operations for creation, replacement, status, abandonment, and revocation", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/invitations/manual-invitation-manager.tsx"), "utf8");
    for (const endpoint of ["manual/create", "manual/replace", "manual/status", "manual/abandon", "revoke", "revoke-all"]) {
      expect(source).toContain(`/api/invitations/${endpoint}`);
    }
    expect(source).toContain("displayOnceUrl");
    expect(source).toContain("inviteToken");
    expect(source).toContain("AbortController");
    expect(source).toContain('role="alert"');
    expect(source).toContain('aria-live="off"');
    expect(source).not.toContain("/api/invites");
  });
});
