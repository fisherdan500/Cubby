// @vitest-environment jsdom
import React, { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.React = React;
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/invitations/invitation-browser", () => ({
  invitationOperationId: vi.fn(() => "11111111-1111-4111-8111-111111111111"),
  invitationFingerprint: vi.fn(async (scope: string) => scope.padEnd(64, "0").slice(0, 64))
}));
import { ManualInvitationManager } from "@/components/invitations/manual-invitation-manager";

const response = (data: Record<string, unknown>) => ({ ok: true, json: async () => ({ ok: true, data }) }) as Response;
const props = { invites: [{ id: "invite-1", email: "member@example.test", role: "parent" as const, expiresAt: "2030-01-01T00:00:00.000Z" }], canInviteAdmin: true, isOwner: true, timeZone: "UTC" };

beforeEach(() => { sessionStorage.clear(); router.refresh.mockClear(); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } }); });
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

const retainedKey = "cubby:invitation-manual-operation:v1";
const operationId = "11111111-1111-4111-8111-111111111111";
const bodies = () => vi.mocked(globalThis.fetch).mock.calls.map(([path, init]) => ({ path: String(path), body: JSON.parse(String(init?.body)) as Record<string, unknown> }));
async function submitCreate() {
  await userEvent.type(screen.getByLabelText("Recipient email"), "new@example.test");
  await userEvent.click(screen.getByRole("button", { name: "Create invitation" }));
}

describe("ManualInvitationManager outcomes", () => {
  it("refreshes the pending list after creation while the display-once link stays available", async () => {
    globalThis.fetch = vi.fn(async (_path, init) => response(JSON.parse(String(init?.body)).action === "reserve" ? { status: "prepared" } : { status: "created", inviteToken: "display-once-token" }));
    const view = render(createElement(ManualInvitationManager, { ...props, invites: [] }));
    await submitCreate();
    await screen.findByRole("region", { name: "Display-once invitation link" });
    expect(screen.getByRole("alert").textContent).toContain("Copy the invitation link now");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    view.rerender(createElement(ManualInvitationManager, { ...props, invites: [{ id: "invite-2", email: "new@example.test", role: "caretaker", expiresAt: "2030-01-01T00:00:00.000Z" }] }));
    expect(screen.getByText("new@example.test")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Display-once invitation link" }).textContent).toContain("display-once-token");
    expect(sessionStorage.getItem(retainedKey)).toBeNull();
  });

  it("says nothing was created when the reservation is refused, and forgets the operation", async () => {
    globalThis.fetch = vi.fn(async () => response({ status: "unavailable" }));
    render(createElement(ManualInvitationManager, { ...props, invites: [] }));
    await submitCreate();
    expect((await screen.findByRole("alert")).textContent).toContain("Nothing was created");
    expect(sessionStorage.getItem(retainedKey)).toBeNull();
    expect(screen.queryByRole("button", { name: "Check request status" })).toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("keeps a retried operation for a status check when its reservation is refused", async () => {
    const retainedCreate = { operationId, openingFingerprint: "manual-create".padEnd(64, "0").slice(0, 64), kind: "create" };
    sessionStorage.setItem(retainedKey, JSON.stringify(retainedCreate));
    globalThis.fetch = vi.fn(async () => response({ status: "unavailable" }));
    render(createElement(ManualInvitationManager, { ...props, invites: [] }));
    await screen.findByRole("button", { name: "Check request status" });
    await submitCreate();
    expect((await screen.findByRole("alert")).textContent).toContain("Check its status");
    expect(JSON.parse(sessionStorage.getItem(retainedKey) ?? "null")).toMatchObject(retainedCreate);
  });

  it("asks the issuer to sign in again when the server requires it", async () => {
    globalThis.fetch = vi.fn(async () => response({ status: "sign_in_required" }));
    render(createElement(ManualInvitationManager, { ...props, invites: [] }));
    await submitCreate();
    expect((await screen.findByRole("alert")).textContent).toContain("Sign in again");
    expect(sessionStorage.getItem(retainedKey)).toBeNull();
  });

  it("keeps the operation for a status check when the submit outcome is unknown", async () => {
    globalThis.fetch = vi.fn(async (_path, init) => { if (JSON.parse(String(init?.body)).action === "reserve") return response({ status: "prepared" }); throw new TypeError("network lost"); });
    render(createElement(ManualInvitationManager, { ...props, invites: [] }));
    await submitCreate();
    expect((await screen.findByRole("alert")).textContent).toContain("Check its status");
    expect(JSON.parse(sessionStorage.getItem(retainedKey) ?? "null")).toMatchObject({ operationId, kind: "create" });
    expect(screen.getByRole("button", { name: "Check request status" })).toBeTruthy();
  });

  it("reconciles a completed create from the status state without redisclosing any token", async () => {
    sessionStorage.setItem(retainedKey, JSON.stringify({ operationId, openingFingerprint: "a".repeat(64), kind: "create" }));
    globalThis.fetch = vi.fn(async () => response({ operationId, state: "TERMINAL_FULL", outcomeCode: "invite_created", inviteToken: "must-not-show" }));
    render(createElement(ManualInvitationManager, { ...props, invites: [] }));
    await userEvent.click(await screen.findByRole("button", { name: "Check request status" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The request completed");
    expect(screen.queryByRole("region", { name: "Display-once invitation link" })).toBeNull();
    expect(document.body.textContent).not.toContain("must-not-show");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(retainedKey)).toBeNull();
  });

  it("reports a still-prepared operation from the status state", async () => {
    sessionStorage.setItem(retainedKey, JSON.stringify({ operationId, openingFingerprint: "a".repeat(64), kind: "create" }));
    globalThis.fetch = vi.fn(async () => response({ operationId, state: "PREPARED" }));
    render(createElement(ManualInvitationManager, { ...props, invites: [] }));
    await userEvent.click(await screen.findByRole("button", { name: "Check request status" }));
    expect((await screen.findByRole("alert")).textContent).toContain("still prepared");
  });

  it("sends the replaced invitation's id with replace submit and status", async () => {
    globalThis.fetch = vi.fn(async (_path, init) => { if (JSON.parse(String(init?.body)).action === "reserve") return response({ status: "prepared" }); throw new TypeError("network lost"); });
    render(createElement(ManualInvitationManager, props));
    await userEvent.click(screen.getByRole("button", { name: "Replace link" }));
    await userEvent.click(await screen.findByRole("button", { name: "Check request status" }));
    const [reserve, submit, status] = bodies();
    expect(reserve!.body).toMatchObject({ action: "reserve", inviteId: "invite-1" });
    expect(submit!.body).toMatchObject({ action: "submit", inviteId: "invite-1" });
    expect(status!.path).toBe("/api/invitations/manual/replace/status");
    expect(status!.body).toMatchObject({ operationId, inviteId: "invite-1" });
  });

  it("shows request feedback beside the form instead of below the pending list", async () => {
    globalThis.fetch = vi.fn(async () => response({ status: "unavailable" }));
    render(createElement(ManualInvitationManager, props));
    await submitCreate();
    const alert = await screen.findByRole("alert");
    const pending = screen.getByRole("heading", { name: "Pending invitations" });
    expect(alert.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("ManualInvitationManager email delivery", () => {
  const created = (email: string) => vi.fn(async (_path, init) => response(JSON.parse(String(init?.body)).action === "reserve" ? { status: "prepared" } : { status: "created", inviteToken: "display-once-token", email }));

  it("offers email ticked by default when available, sends the choice with submit, and still shows the link", async () => {
    globalThis.fetch = created("queued");
    render(createElement(ManualInvitationManager, { ...props, invites: [], emailAvailable: true }));
    expect((screen.getByRole("checkbox", { name: "Also email this invitation" }) as HTMLInputElement).checked).toBe(true);
    await submitCreate();
    await screen.findByRole("region", { name: "Display-once invitation link" });
    const submit = bodies().find(({ body }) => body.action === "submit")!;
    expect(submit.body.sendEmail).toBe(true);
    expect(bodies().find(({ body }) => body.action === "reserve")!.body.sendEmail).toBeUndefined();
    expect(screen.getByRole("alert").textContent).toContain("also being emailed to new@example.test");
  });

  it("does not email when the issuer unticks the box", async () => {
    globalThis.fetch = created("queued");
    render(createElement(ManualInvitationManager, { ...props, invites: [], emailAvailable: true }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Also email this invitation" }));
    await submitCreate();
    await screen.findByRole("region", { name: "Display-once invitation link" });
    expect(bodies().find(({ body }) => body.action === "submit")!.body.sendEmail).toBe(false);
  });

  it("says when the email could not be queued while keeping the link", async () => {
    globalThis.fetch = created("not_queued");
    render(createElement(ManualInvitationManager, { ...props, invites: [], emailAvailable: true }));
    await submitCreate();
    await screen.findByRole("region", { name: "Display-once invitation link" });
    expect(screen.getByRole("alert").textContent).toContain("The email could not be sent");
  });

  it("offers no email choice when email is not set up", async () => {
    globalThis.fetch = created("queued");
    render(createElement(ManualInvitationManager, { ...props, invites: [] }));
    expect(screen.queryByRole("checkbox", { name: "Also email this invitation" })).toBeNull();
    await submitCreate();
    await screen.findByRole("region", { name: "Display-once invitation link" });
    expect(bodies().find(({ body }) => body.action === "submit")!.body.sendEmail).toBeUndefined();
  });

  it("shows each pending invitation's email status and re-sends by emailing a replacement link", async () => {
    globalThis.fetch = vi.fn(async (_path, init) => response(JSON.parse(String(init?.body)).action === "reserve" ? { status: "prepared" } : { status: "replaced", inviteToken: "display-once-token", email: "queued" }));
    const invites = [{ ...props.invites[0]!, emailStatus: "failed" as const }];
    render(createElement(ManualInvitationManager, { ...props, invites, emailAvailable: true }));
    expect(screen.getByText(/Email failed/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Re-send email" }));
    await screen.findByRole("region", { name: "Display-once invitation link" });
    const submit = bodies().find(({ body }) => body.action === "submit")!;
    expect(submit.path).toBe("/api/invitations/manual/replace");
    expect(submit.body).toMatchObject({ inviteId: "invite-1", sendEmail: true });
    expect(router.refresh).toHaveBeenCalled();
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
