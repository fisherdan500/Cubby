// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.React = React;
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/invitations/invitation-browser", () => ({
  invitationOperationId: () => "11111111-1111-4111-8111-111111111111",
  invitationFingerprint: async (scope: string) => scope.padEnd(64, "0").slice(0, 64)
}));
import { ManualInvitationManager } from "@/components/invitations/manual-invitation-manager";

const retainedKey = "cubby:invitation-manual-operation:v1";
const props = { invites: [{ id: "invite-1", email: "member@example.test", role: "parent" as const, expiresAt: "2030-01-01T00:00:00.000Z" }], canInviteAdmin: true, isOwner: true, timeZone: "UTC" };
const response = (data: Record<string, unknown>) => ({ ok: true, json: async () => ({ ok: true, data }) }) as Response;
const actions = ["create", "replace", "revoke", "revoke-all"] as const;
type Action = typeof actions[number];
const labels: Record<Action, string> = { create: "Create invitation", replace: "Replace link", revoke: "Revoke", "revoke-all": "Revoke all pending invitations" };
async function prepare(action: Action) {
  render(createElement(ManualInvitationManager, props));
  if (action === "create") await userEvent.type(screen.getByLabelText("Recipient email"), "new@example.test");
  if (action === "revoke-all") await userEvent.type(screen.getByLabelText(/Type/), "I_REVOKE_ALL_PENDING_INVITATIONS");
}
beforeEach(() => sessionStorage.clear());
afterEach(() => cleanup());

describe("invitation mutation fresh-auth reconciliation", () => {
  it.each(actions)("retains an unknown %s after its retry requires sign-in", async (action) => {
    let mutationAttempts = 0;
    globalThis.fetch = vi.fn(async (_path, init) => {
      if (JSON.parse(String(init?.body)).action === "reserve") return response({ status: "prepared" });
      if (++mutationAttempts === 1) throw new TypeError("response lost");
      return response({ status: "sign_in_required" });
    });
    await prepare(action);
    await userEvent.click(screen.getByRole("button", { name: labels[action] }));
    expect((await screen.findByRole("alert")).textContent).toContain("Check its status");
    const retained = sessionStorage.getItem(retainedKey);
    expect(retained).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: labels[action] }));
    expect((await screen.findByRole("alert")).textContent).toContain("Sign in again");
    expect(screen.getByRole("alert").textContent).not.toContain("Nothing was created or changed");
    expect(screen.getByRole("alert").textContent).toContain("earlier request");
    expect(sessionStorage.getItem(retainedKey)).toBe(retained);
    expect(screen.getByRole("button", { name: "Check request status" })).toBeTruthy();
    expect(mutationAttempts).toBe(2);
  });

  it.each(actions)("can forget a first %s rejected before mutation", async (action) => {
    globalThis.fetch = vi.fn(async (_path, init) => response({ status: JSON.parse(String(init?.body)).action === "reserve" ? "prepared" : "sign_in_required" }));
    await prepare(action);
    await userEvent.click(screen.getByRole("button", { name: labels[action] }));
    expect((await screen.findByRole("alert")).textContent).toContain("Nothing was created or changed");
    expect(sessionStorage.getItem(retainedKey)).toBeNull();
  });
});
