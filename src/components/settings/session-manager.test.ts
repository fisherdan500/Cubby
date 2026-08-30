// @vitest-environment jsdom
import React, { createElement } from "react";
import { createHash, webcrypto } from "node:crypto";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));

import { SessionManager } from "@/components/settings/session-manager";

globalThis.React = React;

const response = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body
}) as Response;

const sessions = [
  {
    handle: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    isCurrent: true,
    deviceLabel: "Chrome on Windows",
    createdAt: "2026-08-01T12:00:00.000Z",
    lastQualifyingAt: "2026-08-29T12:00:00.000Z",
    idleWarningAt: null,
    expiresAt: "2026-09-01T12:00:00.000Z"
  },
  {
    handle: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    isCurrent: false,
    deviceLabel: "Safari on iPhone",
    createdAt: "2026-08-20T12:00:00.000Z",
    lastQualifyingAt: "2026-08-28T12:00:00.000Z",
    idleWarningAt: "2026-08-30T12:00:00.000Z",
    expiresAt: "2026-09-02T12:00:00.000Z"
  }
];

function frame(value: string) {
  const bytes = Buffer.from(value, "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(bytes.length);
  return Buffer.concat([prefix, bytes]);
}

function digest(...values: string[]) {
  return createHash("sha256").update(Buffer.concat(values.map(frame))).digest("hex");
}

beforeEach(() => {
  sessionStorage.clear();
  vi.resetAllMocks();
  const deterministicCrypto = {
    subtle: webcrypto.subtle,
    getRandomValues: <T extends ArrayBufferView | null>(array: T) => {
      if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
      return array;
    }
  };
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: deterministicCrypto });
});

afterEach(cleanup);

describe("SessionManager", () => {
  it("loads only the safe session projection and renders responsive account-session actions", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(response(200, { ok: true, data: { sessions } }));

    render(createElement(SessionManager));

    expect(await screen.findByText("Chrome on Windows")).toBeTruthy();
    expect(screen.getByText("Safari on iPhone")).toBeTruthy();
    expect(screen.getByText("Current device")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out this device" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out this session" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out other devices" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out all devices" })).toBeTruthy();
    expect(screen.queryByText(/IP:/i)).toBeNull();
    expect(document.body.textContent).not.toContain(sessions[0].handle);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/account/sessions", { cache: "no-store" });
  });

  it("uses an inline password confirmation, moves focus to it, and cancels without persisting secrets", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(response(200, { ok: true, data: { sessions } }));
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm");
    render(createElement(SessionManager));
    await screen.findByText("Safari on iPhone");

    await user.click(screen.getByRole("button", { name: "Sign out this session" }));

    const confirmation = screen.getByRole("region", { name: "Confirm session sign-out" });
    const password = within(confirmation).getByLabelText("Current password");
    expect(document.activeElement).toBe(password);
    await user.type(password, "never-store-this");
    expect(confirmSpy).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Confirm session sign-out" })).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("submits exact framed intent metadata and clears it only after an authoritative terminal result", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { sessions } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { operationId: "gso_00000000000000000000000000", status: "revoked", signedOut: false } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { sessions: [sessions[0]] } }));
    globalThis.fetch = fetchMock;
    const user = userEvent.setup();
    render(createElement(SessionManager));
    await screen.findByText("Safari on iPhone");

    await user.click(screen.getByRole("button", { name: "Sign out this session" }));
    await user.type(screen.getByLabelText("Current password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Confirm sign out" }));

    await waitFor(() => expect(screen.queryByText("Safari on iPhone")).toBeNull());
    const payload = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(payload).toEqual({
      operationId: "gso_00000000000000000000000000",
      openingFingerprint: digest("session_revoke_opening", "gso_00000000000000000000000000", "one", sessions[1].handle),
      intentFingerprint: digest("one", sessions[1].handle),
      scope: "one",
      targetHandle: sessions[1].handle,
      confirmed: true,
      currentPassword: "correct horse"
    });
    expect(sessionStorage.length).toBe(0);
  });

  it("retains metadata without password or handle and checks status before reexecution after an unknown outcome", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { sessions } }))
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(response(200, { ok: true, data: { operationId: "gso_00000000000000000000000000", status: "pending" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { operationId: "gso_00000000000000000000000000", status: "pending" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { operationId: "gso_00000000000000000000000000", status: "revoked", signedOut: false } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { sessions: [sessions[0]] } }));
    globalThis.fetch = fetchMock;
    const user = userEvent.setup();
    render(createElement(SessionManager));
    await screen.findByText("Safari on iPhone");

    await user.click(screen.getByRole("button", { name: "Sign out this session" }));
    await user.type(screen.getByLabelText("Current password"), "first password");
    await user.click(screen.getByRole("button", { name: "Confirm sign out" }));
    await screen.findByRole("alert");

    expect(sessionStorage.length).toBe(1);
    const retained = sessionStorage.getItem(sessionStorage.key(0)!);
    expect(retained).toContain("gso_00000000000000000000000000");
    expect(retained).not.toContain("first password");
    expect(retained).not.toContain(sessions[1].handle);

    await user.type(screen.getByLabelText("Current password"), "second password");
    await user.click(screen.getByRole("button", { name: "Confirm sign out" }));
    await waitFor(() => expect(screen.queryByText("Safari on iPhone")).toBeNull());

    expect(fetchMock.mock.calls.slice(1, 6).map(([url]) => url)).toEqual([
      "/api/account/sessions/revoke",
      "/api/account/sessions/status",
      "/api/account/sessions/status",
      "/api/account/sessions/revoke",
      "/api/account/sessions"
    ]);
    const retried = JSON.parse(String(fetchMock.mock.calls[4][1]?.body));
    expect(retried.operationId).toBe("gso_00000000000000000000000000");
    expect(retried.currentPassword).toBe("second password");
    expect(sessionStorage.length).toBe(0);
  });

  it("does not reexecute a retained action once status reports an authoritative terminal result", async () => {
    const operationId = "gso_00000000000000000000000000";
    sessionStorage.setItem("cubby:global-session-revoke-operation", JSON.stringify({
      operationId,
      openingFingerprint: digest("session_revoke_opening", operationId, "one", sessions[1].handle),
      intentFingerprint: digest("one", sessions[1].handle)
    }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { sessions } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { operationId, status: "revoked" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { sessions: [sessions[0]] } }));
    globalThis.fetch = fetchMock;
    const user = userEvent.setup();
    render(createElement(SessionManager));
    await screen.findByText("Safari on iPhone");

    await user.click(screen.getByRole("button", { name: "Sign out this session" }));
    await user.type(screen.getByLabelText("Current password"), "not-reused");
    await user.click(screen.getByRole("button", { name: "Confirm sign out" }));

    await waitFor(() => expect(screen.queryByText("Safari on iPhone")).toBeNull());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/account/sessions",
      "/api/account/sessions/status",
      "/api/account/sessions"
    ]);
    expect(sessionStorage.length).toBe(0);
  });

  it("honors a terminal status immediately after a failed revoke response", async () => {
    const operationId = "gso_00000000000000000000000000";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { sessions } }))
      .mockResolvedValueOnce(response(503, { ok: false, error: { message: "lost response" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { operationId, status: "revoked" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { sessions: [sessions[0]] } }));
    globalThis.fetch = fetchMock;
    const user = userEvent.setup();
    render(createElement(SessionManager));
    await screen.findByText("Safari on iPhone");

    await user.click(screen.getByRole("button", { name: "Sign out this session" }));
    await user.type(screen.getByLabelText("Current password"), "current password");
    await user.click(screen.getByRole("button", { name: "Confirm sign out" }));

    await waitFor(() => expect(screen.queryByText("Safari on iPhone")).toBeNull());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/account/sessions", "/api/account/sessions/revoke", "/api/account/sessions/status", "/api/account/sessions"]);
    expect(sessionStorage.length).toBe(0);
  });

  it.each([
    ["Sign out this device", "current"],
    ["Sign out all devices", "all"]
  ])("redirects to login after %s succeeds", async (buttonName, scope) => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { sessions } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { operationId: "gso_00000000000000000000000000", status: "revoked", signedOut: true } }));
    const user = userEvent.setup();
    render(createElement(SessionManager));
    await screen.findByText("Safari on iPhone");

    await user.click(screen.getByRole("button", { name: buttonName }));
    await user.type(screen.getByLabelText("Current password"), "password");
    await user.click(screen.getByRole("button", { name: "Confirm sign out" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/login"));
    const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1]?.body));
    expect(body.scope).toBe(scope);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});
