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

  // Simplified signup (DEC-PROD-426/428): recovery-code enrolment and rehearsal are no longer part of
  // invitation acceptance, so the three tests that drove that UI are replaced by tests of the flow
  // that now exists. Enrolment itself is NOT gone -- it remains opt-in from ordinary account
  // settings, which is covered by the account-security tests, not here.

  it("offers a single join action with no recovery-code, household-name or acknowledgement friction", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (path) => response(String(path) === "/api/invitations/review" ? review : { status: "unavailable" }));
    render(createElement(InvitationWorkflow));
    expect(await screen.findByRole("button", { name: "Join household" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Generate recovery codes" })).toBeNull();
    expect(screen.queryByLabelText("Re-enter your new password")).toBeNull();
    expect(screen.queryByLabelText("Type the household name exactly")).toBeNull();
    expect(screen.queryByText("Recovery readiness complete: exactly nine unused codes remain.")).toBeNull();
  });

  it("accepts without sending a typed household name or admin acknowledgement", async () => {
    const submitted: Array<Record<string, unknown>> = [];
    vi.mocked(globalThis.fetch).mockImplementation(async (path, init) => {
      if (String(path) === "/api/invitations/review") return response(review);
      if (String(path).endsWith("/accept/reserve")) return response({ status: "prepared" });
      if (String(path).endsWith("/accept/submit")) {
        submitted.push(JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")));
        return response({ status: "accepted" });
      }
      return response({ status: "unavailable" });
    });
    render(createElement(InvitationWorkflow));
    await userEvent.click(await screen.findByRole("button", { name: "Join household" }));
    await waitFor(() => expect(submitted.length).toBe(1));
    expect(submitted[0]).not.toHaveProperty("typedHouseholdName");
    expect(submitted[0]).not.toHaveProperty("adminAcknowledgement");
    expect(typeof submitted[0].intentFingerprint).toBe("string");
  });

  it("offers the same single join action for an admin invitation", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (path) => response(String(path) === "/api/invitations/review" ? { ...review, offered_role: "admin" } : { status: "unavailable" }));
    render(createElement(InvitationWorkflow));
    expect(await screen.findByRole("button", { name: "Join household" })).toBeTruthy();
    expect(screen.queryByLabelText(/I UNDERSTAND ADMIN ACCESS/)).toBeNull();
  });
});
