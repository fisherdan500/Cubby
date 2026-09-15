// @vitest-environment jsdom
import React, { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.React = React;
const root = resolve(process.cwd());

vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => createElement("a", { href, ...props }, children) }));
vi.mock("@/components/invitations/invitation-browser", () => ({
  invitationOperationId: vi.fn(() => "11111111-1111-4111-8111-111111111111"),
  invitationBrowserPartitionDigest: vi.fn(async () => "a".repeat(64)),
  invitationDigest: vi.fn(async () => "b".repeat(64)),
  invitationFingerprint: vi.fn(async (scope: string) => scope.padEnd(64, "0").slice(0, 64))
}));

import { InvitationWorkflow, p13RecoverySubmitRouteOrigin, p13RecoverySubmitSchemaObservation } from "@/components/invitations/invitation-workflow";

const review = { household_name: "The Long Household Name", offered_role: "parent", reviewVersion: 1, reviewSnapshotDigest: "a".repeat(64), remainingActiveCount: 0 };
const response = (data: Record<string, unknown>) => ({ ok: true, json: async () => ({ ok: true, data }) }) as Response;

beforeEach(() => { sessionStorage.clear(); globalThis.fetch = vi.fn(async (path) => response(String(path) === "/api/invitations/review" ? review : { status: "unavailable" })); });
afterEach(() => cleanup());

describe("InvitationWorkflow rendered behavior", () => {
  it("reduces a recovery submit receipt to the authorized closed schema classification", () => {
    const value = { ok: true, data: { status: "completed", codeEntries: Array.from({ length: 10 }, (_, index) => ({ codeId: `opaque-${index}`, code: `DISPLAY-ONCE-${index}` })) } };

    const observed = p13RecoverySubmitSchemaObservation(201, value);

    expect(observed).toEqual({ statusClass: "2xx", ok: "true", data: "present", terminal: "completed", count: "exactly_10", shape: "valid" });
    expect(JSON.stringify(observed)).not.toContain("DISPLAY-ONCE");
    expect(JSON.stringify(observed)).not.toContain("opaque-");
  });

  it("fails closed when recovery submit envelope, terminal status, or entry shape is outside the classifier contract", () => {
    expect(p13RecoverySubmitSchemaObservation(299, { ok: false, data: { status: "unexpected", codeEntries: [{}] } })).toEqual({
      statusClass: "2xx", ok: "false", data: "present", terminal: "other", count: "other", shape: "invalid"
    });
    expect(p13RecoverySubmitSchemaObservation(0, null)).toEqual({
      statusClass: "invalid", ok: "absent", data: "absent", terminal: "absent", count: "absent", shape: "invalid"
    });
  });

  it("allows only the designated fixed recovery submit route-origin labels", () => {
    expect(p13RecoverySubmitRouteOrigin("submit_terminal_unavailable")).toBe("submit_terminal_unavailable");
    expect(p13RecoverySubmitRouteOrigin("submit_terminal_completed")).toBe("submit_terminal_completed");
    expect(p13RecoverySubmitRouteOrigin("submit_state_fresh_auth_bound")).toBe("submit_state_fresh_auth_bound");
    expect(p13RecoverySubmitRouteOrigin("submit_state_prepared")).toBe("submit_state_prepared");
    expect(p13RecoverySubmitRouteOrigin("submit_state_other")).toBe("submit_state_other");
    expect(p13RecoverySubmitRouteOrigin("submit_receipt_invalid")).toBe("submit_receipt_invalid");
    expect(p13RecoverySubmitRouteOrigin("invalid")).toBe("submit_server_legacy_invalid");
    expect(p13RecoverySubmitRouteOrigin("unexpected")).toBe("submit_header_unsupported");
    expect(p13RecoverySubmitRouteOrigin(null)).toBe("observer_absent");
  });

  it("accepts the credential procedure's continue_with_sign_in result and exposes an alert summary", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (path) => response(
      String(path) === "/api/invitations/review" ? {} : String(path).endsWith("/reserve") ? { status: "prepared" } : { status: "continue_with_sign_in" }
    ));
    render(createElement(InvitationWorkflow));
    await screen.findByRole("form", { name: "Create invited account credentials" });
    await userEvent.type(screen.getByLabelText("Display name"), "Taylor");
    await userEvent.type(screen.getByLabelText("Email"), "taylor@example.test");
    await userEvent.type(screen.getByLabelText("New password"), "long-enough-password");
    fireEvent.submit(screen.getByRole("form", { name: "Create invited account credentials" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Credentials are ready");
  });

  it("renders a retained credential operation before sign-in review is available", async () => {
    sessionStorage.setItem("cubby:invitation-workflow-operation:v1", JSON.stringify({
      kind: "credential", operationId: "11111111-1111-4111-8111-111111111111", openingFingerprint: "a".repeat(64), intentFingerprint: "b".repeat(64), recipientEmailDigest: "c".repeat(64), browserPartitionDigest: "d".repeat(64)
    }));
    vi.mocked(globalThis.fetch).mockImplementation(async () => response({}));

    render(createElement(InvitationWorkflow));
    expect(await screen.findByRole("region", { name: "Retained invitation operation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check retained step status" })).toBeTruthy();
  });

  it.each(["generated", "completed"] as const)("shows plaintext recovery codes for the initial %s receipt, focuses their quiet secret region, and never retains them", async (status) => {
    let generated = false;
    vi.mocked(globalThis.fetch).mockImplementation(async (path) => {
      if (String(path) === "/api/invitations/review") return response(review);
      if (String(path).endsWith("/reserve")) return response({ status: "prepared", globalSecurityOperationId: "gso_0123456789abcdefghjkmnpqr" });
      if (String(path).endsWith("/fresh-auth")) return response({ status: "fresh_auth_bound" });
      generated = true;
      return response({ status, codeEntries: Array.from({ length: 10 }, (_, index) => ({ codeId: `code-${index}`, code: `DISPLAY-ONCE-${index}` })) });
    });
    const view = render(createElement(InvitationWorkflow));
    await userEvent.type(await screen.findByLabelText("Re-enter your new password"), "fresh-password");
    await userEvent.click(await screen.findByRole("button", { name: "Generate recovery codes" }));
    const codes = await screen.findByRole("region", { name: "Display-once recovery codes" });
    expect(codes.getAttribute("aria-live")).toBe("off");
    expect(document.activeElement).toBe(codes);
    expect(sessionStorage.getItem("cubby:invitation-workflow-operation:v1") ?? "").not.toContain("DISPLAY-ONCE");
    view.unmount();
    render(createElement(InvitationWorkflow));
    await waitFor(() => expect(generated).toBe(true));
    expect(screen.queryByText("DISPLAY-ONCE-0")).toBeNull();
  });

  it("shows a regeneration notice only when the account already has prior recovery codes", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (path) => response(String(path) === "/api/invitations/review" ? { ...review, hasPriorRecoveryCodes: true } : { status: "unavailable" }));
    render(createElement(InvitationWorkflow));
    await screen.findByRole("button", { name: "Generate recovery codes" });
    expect(await screen.findByText("Completing this will invalidate any previously issued recovery codes.")).toBeTruthy();
  });

  it("omits the regeneration notice for a first-time enrollment with no prior codes", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (path) => response(String(path) === "/api/invitations/review" ? { ...review, hasPriorRecoveryCodes: false } : { status: "unavailable" }));
    render(createElement(InvitationWorkflow));
    await screen.findByRole("button", { name: "Generate recovery codes" });
    expect(screen.queryByText("Completing this will invalidate any previously issued recovery codes.")).toBeNull();
  });
});

describe("invitation workflow UI contract", () => {
  it("keeps invitation presentation token-free and provides the reviewed convergent workflow controls", () => {
    const page = readFileSync(resolve(root, "src/app/invite/page.tsx"), "utf8");
    const workflow = readFileSync(resolve(root, "src/components/invitations/invitation-workflow.tsx"), "utf8");
    expect(page).toContain("InvitationBootstrap");
    expect(page).not.toMatch(/\[token\]|searchParams|params/);
    expect(workflow).toContain("autoComplete=\"name\"");
    expect(workflow).toContain("autoComplete=\"new-password\"");
    expect(workflow).toContain("I SAVED MY RECOVERY CODES");
    expect(workflow).not.toContain("I_SAVED_MY_RECOVERY_CODES");
    expect(workflow).toContain("I UNDERSTAND ADMIN ACCESS");
    expect(workflow).toContain("aria-live=\"polite\"");
    expect(workflow).toContain("AbortController");
    expect(workflow).toContain("remainingActiveCount");
    expect(workflow).toContain("hasPriorRecoveryCodes");
  });

  it("dispatches only a bound review to the invitation page and all neutral outcomes to the landing page", () => {
    const dispatch = readFileSync(resolve(root, "src/app/invite/dispatch/page.tsx"), "utf8");
    expect(dispatch).toContain('status === "review"');
    expect(dispatch).toContain('? "/invite" : "/"');
    expect(dispatch).not.toContain('window.location.replace("/invite")');
  });
});
