// @vitest-environment jsdom
import React, { createElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));
import { NotificationPreferenceForm } from "@/components/settings/notification-preference-form";

globalThis.React = React;
const response = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
const storageKey = "cubby:notification-preference-operation:household-a:tab:test";
async function submitMountedForm() {
  const form = screen.getByRole("button", { name: "Save notification preferences" }).closest("form") as HTMLFormElement;
  const key = Object.keys(form).find((value) => value.startsWith("__reactProps$"));
  const props = (form as unknown as Record<string, { action: (data: FormData) => Promise<void> }>)[key!];
  await act(async () => { await props.action(new FormData(form)); });
}
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  sessionStorage.clear(); mocks.refresh.mockReset();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { cleanup(); consoleError.mockRestore(); });

describe("NotificationPreferenceForm", () => {
  it("mounts the complete preference document and updates delivery and baby scope controls", async () => {
    render(createElement(NotificationPreferenceForm, { babies: [{ id: "baby-1", name: "Avery" }], state: "unsaved_off" }));
    const delivery = screen.getByRole("checkbox", { name: "Enable external delivery" }) as HTMLInputElement;
    const selected = screen.getByRole("radio", { name: "Selected babies" }) as HTMLInputElement;
    for (const control of [...screen.getAllByRole("checkbox"), ...screen.getAllByRole("radio")]) {
      expect(control.closest("label")?.className).toContain("min-h-11");
    }

    await userEvent.click(delivery);
    await userEvent.click(selected);
    await userEvent.selectOptions(screen.getByRole("listbox", { name: "Selected babies" }), "baby-1");

    expect(delivery.checked).toBe(true);
    expect(selected.checked).toBe(true);
    expect(screen.getByText(/External delivery is off/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save notification preferences" })).toBeTruthy();
  });

  it("submits an open notification reservation with the same ID", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(NotificationPreferenceForm, { babies: [{ id: "baby-1", name: "Avery" }], state: "unsaved_off" }));
    await submitMountedForm();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", "/api/notifications/preferences/issue", "/api/notifications/preferences"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({ operationId });
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("resumes a retained prepared notification reservation with the same ID", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    sessionStorage.setItem(storageKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(202, { ok: true, data: { status: "prepared", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(NotificationPreferenceForm, { babies: [], state: "active" }));
    await submitMountedForm();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", `/api/browser-operations/${operationId}`, "/api/notifications/preferences"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({ operationId });
  });

  it.each([
    ["pending", 200, { ok: true, data: { status: "pending", operationId: "bmo_0123456789abcdefghjkmnpqrs" } }],
    ["404", 404, { ok: false, error: { code: "not_found" } }]
  ])("retains a %s notification reservation without issuing a replacement", async (_label, status, body) => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    sessionStorage.setItem(storageKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(status as number, body));
    globalThis.fetch = fetchMock;
    render(createElement(NotificationPreferenceForm, { babies: [], state: "active" }));
    await submitMountedForm();
    await screen.findByText(/reconcile|unknown|Could not/i);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", `/api/browser-operations/${operationId}`
    ]);
    expect(sessionStorage.getItem(storageKey)).toBe(operationId);
  });

  it("clears an exact authorized 410 then submits a replacement notification ID", async () => {
    const oldId = "bmo_0123456789abcdefghjkmnpqrs";
    const newId = "bmo_1123456789abcdefghjkmnpqrs";
    sessionStorage.setItem(storageKey, oldId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(410, { ok: true, data: { status: "expired", operationId: oldId, code: "operation_result_expired" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId: newId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId: newId } }));
    globalThis.fetch = fetchMock;
    render(createElement(NotificationPreferenceForm, { babies: [], state: "active" }));
    await submitMountedForm();
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    await screen.findByText(/expired/);
    await submitMountedForm();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", `/api/browser-operations/${oldId}`,
      "/api/browser-operations/partition", "/api/notifications/preferences/issue", "/api/notifications/preferences"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[4][1]?.body))).toMatchObject({ operationId: newId });
  });
});
