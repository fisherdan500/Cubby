// @vitest-environment jsdom
import React, { createElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultUnitPreferences } from "@/domain/unit-preferences";

const mocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));
import { ActivityForm } from "@/components/forms/activity-form";
import { InviteForm } from "@/components/forms/invite-form";

globalThis.React = React;
let consoleError: ReturnType<typeof vi.spyOn>;
const result = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
beforeEach(() => {
  sessionStorage.clear();
  vi.resetAllMocks();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { cleanup(); consoleError.mockRestore(); });

describe("durable editable browser-operation forms", () => {
  it("mounts and edits an activity form", async () => {
    render(createElement(ActivityForm, {
      babies: [{ id: "baby-1", name: "Avery" }], type: "note", selectedBabyId: "baby-1", appTimeZone: "UTC",
      unitPreferences: defaultUnitPreferences, medicineNames: [], supplementNames: []
    }));
    const note = screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;
    await userEvent.type(note, "Updated note");
    expect(note.value).toBe("Updated note");
  });

  it("mounts invite creation with owner-only Admin access", async () => {
    render(createElement(InviteForm, { canInviteAdmin: true }));
    const email = screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement;
    expect(screen.getByRole("combobox", { name: "Role" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Invitation expiry" })).toBeTruthy();
    await userEvent.type(email, "invitee@example.com");
    expect(email.value).toBe("invitee@example.com");
    expect(screen.getByRole("option", { name: "Admin" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite member" })).toBeTruthy();
  });

  const operationId = "bmo_0123456789abcdefghjkmnpqrs";
  const storageKey = "cubby:invite-create-operation:household-a:tab:test";
  const partition = result(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } });

  async function submitInvite() {
    const user = userEvent.setup();
    const email = screen.getByPlaceholderText("caretaker@example.com");
    await user.type(email, "invitee@example.com");
    const form = email.closest("form") as HTMLFormElement;
    const reactPropsKey = Object.keys(form).find((key) => key.startsWith("__reactProps$"));
    expect(reactPropsKey).toBeDefined();
    const props = (form as unknown as Record<string, { action: (data: FormData) => Promise<void> }>)[reactPropsKey!];
    await act(async () => { await props.action(new FormData(form)); });
  }

  it("resumes a retained prepared invitation with the same ID", async () => {
    sessionStorage.setItem(storageKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(202, { ok: true, data: { status: "prepared", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId, outcome: { acceptUrl: "/invite/once" } } }));
    globalThis.fetch = fetchMock;

    render(createElement(InviteForm, { canInviteAdmin: false }));
    await submitInvite();

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      `/api/browser-operations/${operationId}`,
      "/api/invites"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      email: "invitee@example.com",
      operationId
    });
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it.each([
    ["pending", 200, { ok: true, data: { status: "pending", operationId } }],
    ["404", 404, { ok: false, error: { code: "not_found" } }],
    ["unknown", 200, { ok: true, data: { status: "unexpected", operationId } }],
    ["stale", 200, { ok: true, data: { status: "stale", operationId } }],
    ["rejected", 200, { ok: true, data: { status: "rejected", operationId } }]
  ])("retains a %s invitation without issuing a replacement", async (_label, status, body) => {
    sessionStorage.setItem(storageKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(status as number, body));
    globalThis.fetch = fetchMock;

    render(createElement(InviteForm, { canInviteAdmin: false }));
    await submitInvite();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      `/api/browser-operations/${operationId}`
    ]);
    expect(sessionStorage.getItem(storageKey)).toBe(operationId);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("clears a retained completed invitation", async () => {
    sessionStorage.setItem(storageKey, operationId);
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));

    render(createElement(InviteForm, { canInviteAdmin: false }));
    await submitInvite();

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("clears an authorized 410 invitation before issuing a replacement", async () => {
    const replacementId = "bmo_0123456789abcdefghjkmnpqrt";
    sessionStorage.setItem(storageKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(410, { ok: true, data: { status: "expired", operationId, code: "operation_result_expired" } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId: replacementId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId: replacementId, outcome: { acceptUrl: "/invite/once" } } }));
    globalThis.fetch = fetchMock;

    render(createElement(InviteForm, { canInviteAdmin: false }));
    await submitInvite();

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      `/api/browser-operations/${operationId}`,
      "/api/invites?issue=1",
      "/api/invites"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toMatchObject({ operationId: replacementId });
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });
});
