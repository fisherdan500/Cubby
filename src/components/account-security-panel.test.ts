// @vitest-environment jsdom
import React, { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSecurityPanel } from "@/components/account-security-panel";

globalThis.React = React;

const navigation = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

beforeEach(() => {
  sessionStorage.clear();
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      ok: true,
      data: {
        operationId: "gso_0123456789abcdefghjkmnpqrs",
        setVersion: 1,
        codes: ["display-once-code"],
        displayOnce: true,
        status: "pending"
      }
    })
  });
});
afterEach(() => cleanup());

describe("AccountSecurityPanel", () => {
  const renderPanel = (accountScope = "user-one") => render(createElement(AccountSecurityPanel, { accountScope }));
  it("gives each credential workflow a named region and recovery its own current-password field", async () => {
    renderPanel();

    expect(screen.getByRole("region", { name: "Change password" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Offline recovery codes" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Change email address" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Current password for password change"), "password-change current");
    await userEvent.type(screen.getByLabelText("New password"), "password-change next");
    const recoveryPassword = screen.getByLabelText("Current password for recovery codes");
    await userEvent.type(recoveryPassword, "recovery password");

    expect((screen.getByRole("button", { name: "Create recovery codes" }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Create recovery codes" }));
    expect((screen.getByLabelText("Current password for password change") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("");
  });

  it("offers touch-sized starting controls and hides state-specific email actions before initiation", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Regenerate recovery codes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check email-change status" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel email change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm this device" })).toBeNull();
    for (const input of screen.getAllByRole("textbox")) expect(input.className).toContain("min-h-11");
  });

  it("uses visible labels and native forms for unambiguous credential submissions", async () => {
    renderPanel();
    for (const id of ["password-current", "password-next", "recovery-current", "email-current", "email-next"]) {
      expect(document.querySelector(`label[for="${id}"]`)).toBeTruthy();
    }

    await userEvent.type(screen.getByLabelText("Current password for password change"), "current password");
    await userEvent.type(screen.getByLabelText("New password"), "new password");
    fireEvent.submit(screen.getByRole("form", { name: "Change password" }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("/api/account/security/password", expect.objectContaining({ method: "POST" })));

    await userEvent.type(screen.getByLabelText("Current password for email change"), "current password");
    await userEvent.type(screen.getByLabelText("New email address"), "new@example.test");
    fireEvent.submit(screen.getByRole("form", { name: "Change email address" }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("/api/account/security/email-change", expect.objectContaining({ method: "POST" })));
  });

  it("never retains passwords, codes, verification material, or addresses in browser storage and clears display-once codes", async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText("Current password for password change"), "current password");
    await userEvent.type(screen.getByLabelText("New password"), "new password");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(sessionStorage.length).toBeGreaterThan(0));
    for (let index = 0; index < sessionStorage.length; index += 1) {
      expect(sessionStorage.getItem(sessionStorage.key(index)!)).not.toMatch(/current password|new password|display-once-code|@/i);
    }
    await userEvent.type(screen.getByLabelText("Current password for recovery codes"), "current password");
    await userEvent.click(screen.getByRole("button", { name: "Create recovery codes" }));
    await screen.findByRole("region", { name: "Display-once recovery codes" });
    await userEvent.click(screen.getByRole("button", { name: "I saved these codes" }));
    expect(screen.queryByText("display-once-code")).toBeNull();
  });

  it("reuses the enrollment operation identity for rehearsal instead of opening a conflicting operation", async () => {
    renderPanel();
    await userEvent.type(screen.getByLabelText("Current password for recovery codes"), "current password");
    await userEvent.click(screen.getByRole("button", { name: "Create recovery codes" }));
    await screen.findByRole("region", { name: "Display-once recovery codes" });
    await userEvent.click(screen.getByRole("button", { name: "I saved these codes" }));
    await userEvent.type(screen.getByLabelText("Rehearse one unused code"), "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01");
    await userEvent.click(screen.getByRole("button", { name: "Rehearse code" }));
    const calls = vi.mocked(globalThis.fetch).mock.calls.map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    const enrollment = calls.find((body) => body.action === "enroll");
    const rehearsal = calls.find((body) => body.action === "rehearse");
    expect(rehearsal?.operationId).toBe(enrollment?.operationId);
    expect(rehearsal?.openingFingerprint).toBe(enrollment?.openingFingerprint);
    expect(rehearsal?.intentFingerprint).toBe(enrollment?.intentFingerprint);
  });

  it("persists only safe recovery and email operation metadata before an ambiguous submit", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network"));
    renderPanel();
    await userEvent.type(screen.getByLabelText("Current password for recovery codes"), "current password");
    await userEvent.click(screen.getByRole("button", { name: "Create recovery codes" }));
    await waitFor(() => expect(sessionStorage.getItem("cubby:global-security:user-one:recovery-operation")).toBeTruthy());
    await userEvent.type(screen.getByLabelText("Current password for email change"), "current password");
    await userEvent.type(screen.getByLabelText("New email address"), "new@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Send verification" }));
    await waitFor(() => expect(sessionStorage.getItem("cubby:global-security:user-one:email-operation")).toBeTruthy());
    const retained = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index)!)).join("|");
    expect(retained).not.toMatch(/current password|new@example|display-once|verification/i);
  });

  it("reconciles a retained recovery operation with the exact metadata-only status shape", async () => {
    sessionStorage.setItem("cubby:global-security:user-one:recovery-operation", JSON.stringify({
      operationId: "gso_0123456789abcdefghjkmnpqrs",
      openingFingerprint: "a".repeat(64),
      intentFingerprint: "b".repeat(64),
      action: "enroll",
      setVersion: 2
    }));
    renderPanel();
    await waitFor(() => expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled());
    const recoveryStatusCall = vi.mocked(globalThis.fetch).mock.calls.find(([path]) => path === "/api/account/security/recovery");
    expect(JSON.parse(String(recoveryStatusCall?.[1]?.body))).toEqual({
      action: "status",
      operationId: "gso_0123456789abcdefghjkmnpqrs",
      openingFingerprint: "a".repeat(64),
      intentFingerprint: "b".repeat(64)
    });
  });

  it("retries an ambiguous password submit with the exact retained identity and blocks a fresh operation", async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { status: "completed", signInRequired: true } }) } as Response);
    renderPanel();
    await userEvent.type(screen.getByLabelText("Current password for password change"), "current password");
    await userEvent.type(screen.getByLabelText("New password"), "new password");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    await screen.findByRole("button", { name: "Retry password change" });
    await userEvent.type(screen.getByLabelText("Current password for password change"), "current password");
    await userEvent.type(screen.getByLabelText("New password"), "new password");
    await userEvent.click(screen.getByRole("button", { name: "Retry password change" }));
    const submits = fetchMock.mock.calls.filter(([path]) => path === "/api/account/security/password").map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(submits).toHaveLength(2);
    expect(submits[1]?.operationId).toBe(submits[0]?.operationId);
    expect(submits[1]?.openingFingerprint).toBe(submits[0]?.openingFingerprint);
    expect(submits[1]?.intentFingerprint).toBe(submits[0]?.intentFingerprint);
    expect(sessionStorage.getItem("cubby:global-security:user-one:password-operation")).toBeNull();
    expect(navigation.replace).toHaveBeenCalledWith("/login");
  });

  it("partitions retained operation metadata by authenticated account", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network"));
    const first = renderPanel("user-one");
    await userEvent.type(screen.getByLabelText("Current password for password change"), "current password");
    await userEvent.type(screen.getByLabelText("New password"), "new password");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(sessionStorage.getItem("cubby:global-security:user-one:password-operation")).toBeTruthy());
    first.unmount();
    renderPanel("user-two");
    expect(screen.queryByRole("button", { name: "Retry password change" })).toBeNull();
  });

  it("clears display-once codes before an acknowledgement response can be lost", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { operationId: "gso_0123456789abcdefghjkmnpqrs", setVersion: 1, codes: ["display-once-code"] } }) } as Response)
      .mockRejectedValueOnce(new Error("network"));
    renderPanel();
    await userEvent.type(screen.getByLabelText("Current password for recovery codes"), "current password");
    await userEvent.click(screen.getByRole("button", { name: "Create recovery codes" }));
    await screen.findByText("display-once-code");
    await userEvent.click(screen.getByRole("button", { name: "I saved these codes" }));
    expect(screen.queryByText("display-once-code")).toBeNull();
  });

  it("retries ambiguous recovery enrollment and email initiation with their exact retained identities", async () => {
    const fetchMock = vi.mocked(globalThis.fetch)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { setVersion: 1, codes: ["display-once-code"] } }) } as Response)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { status: "pending" } }) } as Response);
    renderPanel();
    await userEvent.type(screen.getByLabelText("Current password for recovery codes"), "current password");
    await userEvent.click(screen.getByRole("button", { name: "Create recovery codes" }));
    await screen.findByRole("button", { name: "Retry recovery enrollment" });
    await userEvent.type(screen.getByLabelText("Current password for recovery codes"), "current password");
    await userEvent.click(screen.getByRole("button", { name: "Retry recovery enrollment" }));
    await screen.findByText("display-once-code");
    await userEvent.type(screen.getByLabelText("Current password for email change"), "current password");
    await userEvent.type(screen.getByLabelText("New email address"), "new@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Send verification" }));
    await screen.findByRole("button", { name: "Retry email change" });
    await userEvent.type(screen.getByLabelText("Current password for email change"), "current password");
    await userEvent.type(screen.getByLabelText("New email address"), "new@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Retry email change" }));
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    const recovery = bodies.filter((body) => body.action === "enroll");
    const email = bodies.filter((body) => body.action === "initiate");
    expect(recovery[1]?.operationId).toBe(recovery[0]?.operationId);
    expect(email[1]?.operationId).toBe(email[0]?.operationId);
  });

  it("clears terminal operation pointers after authoritative reconciliation", async () => {
    const metadata = { operationId: "gso_0123456789abcdefghjkmnpqrs", openingFingerprint: "a".repeat(64), intentFingerprint: "b".repeat(64) };
    sessionStorage.setItem("cubby:global-security:user-one:password-operation", JSON.stringify(metadata));
    sessionStorage.setItem("cubby:global-security:user-one:recovery-operation", JSON.stringify({ ...metadata, action: "enroll", setVersion: 1 }));
    sessionStorage.setItem("cubby:global-security:user-one:email-operation", JSON.stringify(metadata));
    vi.mocked(globalThis.fetch).mockImplementation(async (path) => {
      const data = String(path).includes("password/status") ? { status: "completed" } : String(path).includes("recovery") ? { state: "rehearsed" } : { status: "rejected" };
      return { ok: true, json: async () => ({ ok: true, data }) } as Response;
    });
    renderPanel();
    await waitFor(() => expect(sessionStorage.length).toBe(0));
  });

  it("enables successor confirmation for the real cutover status issued", async () => {
    sessionStorage.setItem("cubby:global-security:user-one:email-operation", JSON.stringify({
      operationId: "gso_0123456789abcdefghjkmnpqrs",
      openingFingerprint: "a".repeat(64),
      intentFingerprint: "b".repeat(64)
    }));
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { status: "issued", cookieState: null } })
    } as Response);

    renderPanel();

    const confirm = await screen.findByRole("button", { name: "Confirm this device" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByRole("button", { name: "Complete email change" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Verify new address" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("announces an old-address security-notice delivery failure without blocking confirmation", async () => {
    sessionStorage.setItem("cubby:global-security:user-one:email-operation", JSON.stringify({
      operationId: "gso_0123456789abcdefghjkmnpqrs",
      openingFingerprint: "a".repeat(64),
      intentFingerprint: "b".repeat(64)
    }));
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { status: "issued", oldAddressNoticeFailed: true } })
    } as Response);

    renderPanel();

    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toContain("old email address could not be delivered");
    expect((screen.getByRole("button", { name: "Confirm this device" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the retained email pointer when cutover closes with signed_out", async () => {
    sessionStorage.setItem("cubby:global-security:user-one:email-operation", JSON.stringify({
      operationId: "gso_0123456789abcdefghjkmnpqrs",
      openingFingerprint: "a".repeat(64),
      intentFingerprint: "b".repeat(64)
    }));
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { status: "signed_out" } })
    } as Response);

    renderPanel();

    await waitFor(() => expect(sessionStorage.getItem("cubby:global-security:user-one:email-operation")).toBeNull());
    expect(screen.queryByRole("button", { name: "Confirm this device" })).toBeNull();
  });

  it("requires ordinary sign-in immediately when email cutover returns signed_out", async () => {
    sessionStorage.setItem("cubby:global-security:user-one:email-operation", JSON.stringify({
      operationId: "gso_0123456789abcdefghjkmnpqrs",
      openingFingerprint: "a".repeat(64),
      intentFingerprint: "b".repeat(64)
    }));
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { status: "verified" } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, data: { status: "signed_out", signInRequired: true } }) } as Response);

    renderPanel();
    const cutover = await screen.findByRole("button", { name: "Complete email change" });
    await waitFor(() => expect((cutover as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(cutover);

    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith("/login"));
    expect(sessionStorage.getItem("cubby:global-security:user-one:email-operation")).toBeNull();
  });

  it("clears display-once codes immediately when the authenticated account scope changes", async () => {
    const view = renderPanel("user-one");
    await userEvent.type(screen.getByLabelText("Current password for recovery codes"), "current password");
    await userEvent.click(screen.getByRole("button", { name: "Create recovery codes" }));
    await screen.findByText("display-once-code");
    view.rerender(createElement(AccountSecurityPanel, { accountScope: "user-two" }));
    await waitFor(() => expect(screen.queryByText("display-once-code")).toBeNull());
  });

  it("ignores a late recovery response from the previous authenticated account", async () => {
    let resolveRecovery!: (value: Response) => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveRecovery = resolve; }));
    const view = renderPanel("user-one");
    await userEvent.type(screen.getByLabelText("Current password for recovery codes"), "current password");
    await userEvent.click(screen.getByRole("button", { name: "Create recovery codes" }));

    view.rerender(createElement(AccountSecurityPanel, { accountScope: "user-two" }));
    await act(async () => resolveRecovery({ ok: true, json: async () => ({ ok: true, data: { operationId: "gso_0123456789abcdefghjkmnpqrs", setVersion: 1, codes: ["previous-account-code"] } }) } as Response));

    expect(screen.queryByText("previous-account-code")).toBeNull();
    expect(screen.getByRole("status").textContent).not.toContain("Save these recovery codes");
  });

  it("ignores late retained-operation reconciliation from the previous authenticated account", async () => {
    sessionStorage.setItem("cubby:global-security:user-one:email-operation", JSON.stringify({
      operationId: "gso_0123456789abcdefghjkmnpqrs",
      openingFingerprint: "a".repeat(64),
      intentFingerprint: "b".repeat(64)
    }));
    let resolveStatus!: (value: Response) => void;
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveStatus = resolve; }));
    const view = renderPanel("user-one");

    view.rerender(createElement(AccountSecurityPanel, { accountScope: "user-two" }));
    await act(async () => resolveStatus({ ok: true, json: async () => ({ ok: true, data: { status: "issued" } }) } as Response));

    expect(screen.getByRole("status").textContent).not.toContain("issued");
    expect(screen.queryByRole("button", { name: "Confirm this device" })).toBeNull();
  });
});
