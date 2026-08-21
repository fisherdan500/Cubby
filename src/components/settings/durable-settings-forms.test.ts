// @vitest-environment jsdom
import React, { createElement } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultUnitPreferences } from "@/domain/unit-preferences";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));

import { AppearanceForm } from "@/components/settings/appearance-form";
import { UnitPreferencesForm } from "@/components/settings/unit-preferences-form";

globalThis.React = React;

function response(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

const unitStorageKey = "cubby:unit-preferences-operation:household-a:tab:test";
async function submitMountedUnits() {
  const form = screen.getByRole("button", { name: "Save unit defaults" }).closest("form") as HTMLFormElement;
  const key = Object.keys(form).find((value) => value.startsWith("__reactProps$"));
  const props = (form as unknown as Record<string, { action: (data: FormData) => Promise<void> }>)[key!];
  await act(async () => { await props.action(new FormData(form)); });
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  sessionStorage.clear();
  mocks.refresh.mockReset();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { cleanup(); consoleError.mockRestore(); });

describe("durable household settings forms", () => {
  it("mounts Family accent and completes a partitioned server reservation", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    const user = userEvent.setup();

    render(createElement(AppearanceForm, { initialTheme: "sage" }));
    await user.click(screen.getByRole("radio", { name: /Dusty rose/i }));
    await user.click(screen.getByRole("button", { name: "Save Family accent" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Family accent saved."));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      "/api/settings/appearance/issue",
      "/api/settings/appearance"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ operationId, accentTheme: "rose" });
    expect(sessionStorage.getItem("cubby:household-accent-operation:household-a:tab:test")).toBeNull();
  });

  it("resumes a retained prepared Family accent reservation with the same ID", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    sessionStorage.setItem("cubby:household-accent-operation:household-a:tab:test", operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(202, { ok: true, data: { status: "prepared", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(AppearanceForm, { initialTheme: "sage" }));
    await userEvent.click(screen.getByRole("radio", { name: /Dusty rose/i }));
    await userEvent.click(screen.getByRole("button", { name: "Save Family accent" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", `/api/browser-operations/${operationId}`, "/api/settings/appearance"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ operationId, accentTheme: "rose" });
  });

  it("moves Family accent focus and selection with ArrowRight", async () => {
    render(createElement(AppearanceForm, { initialTheme: "sage" }));
    const sage = screen.getByRole("radio", { name: /Sage/ });
    sage.focus();

    await userEvent.keyboard("{ArrowRight}");

    const rose = screen.getByRole("radio", { name: /Dusty rose/i });
    expect(document.activeElement).toBe(rose);
    expect(rose.getAttribute("aria-checked")).toBe("true");
  });

  it("mounts Units and updates the complete document controls", async () => {
    const user = userEvent.setup();

    render(createElement(UnitPreferencesForm, { preferences: defaultUnitPreferences, medicineNames: [], supplementNames: [] }));
    const volume = screen.getByRole("combobox", { name: /Volume/ }) as HTMLSelectElement;
    await user.selectOptions(volume, "mL");

    expect(volume.value).toBe("mL");
    expect((screen.getByRole("combobox", { name: /Weight/ }) as HTMLSelectElement).value).toBe("lb");
    expect((screen.getByRole("combobox", { name: /Length and head circumference/ }) as HTMLSelectElement).value).toBe("in");
    expect((screen.getByRole("combobox", { name: /Temperature/ }) as HTMLSelectElement).value).toBe("F");
    expect(screen.getByRole("button", { name: "Save unit defaults" })).toBeTruthy();
  });

  it("submits an open unit-preference reservation with the same ID", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(UnitPreferencesForm, { preferences: defaultUnitPreferences, medicineNames: [], supplementNames: [] }));
    await submitMountedUnits();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", "/api/settings/units/issue", "/api/settings/units"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({ operationId });
    expect(sessionStorage.getItem(unitStorageKey)).toBeNull();
  });

  it("resumes a retained prepared unit-preference reservation with the same ID", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    sessionStorage.setItem(unitStorageKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(202, { ok: true, data: { status: "prepared", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(UnitPreferencesForm, { preferences: defaultUnitPreferences, medicineNames: [], supplementNames: [] }));
    await submitMountedUnits();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", `/api/browser-operations/${operationId}`, "/api/settings/units"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({ operationId });
  });

  it.each([
    ["pending", 200, { ok: true, data: { status: "pending", operationId: "bmo_0123456789abcdefghjkmnpqrs" } }],
    ["404", 404, { ok: false, error: { code: "not_found" } }]
  ])("retains a %s unit-preference reservation", async (_label, status, body) => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    sessionStorage.setItem(unitStorageKey, operationId);
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(status as number, body));
    render(createElement(UnitPreferencesForm, { preferences: defaultUnitPreferences, medicineNames: [], supplementNames: [] }));
    await submitMountedUnits();
    await screen.findByText(/reconcile|unknown|Could not/i);
    expect(sessionStorage.getItem(unitStorageKey)).toBe(operationId);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("clears an authorized 410 and submits a replacement unit-preference ID", async () => {
    const oldId = "bmo_0123456789abcdefghjkmnpqrs";
    const newId = "bmo_1123456789abcdefghjkmnpqrs";
    sessionStorage.setItem(unitStorageKey, oldId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(410, { ok: true, data: { status: "expired", operationId: oldId, code: "operation_result_expired" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId: newId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId: newId } }));
    globalThis.fetch = fetchMock;
    render(createElement(UnitPreferencesForm, { preferences: defaultUnitPreferences, medicineNames: [], supplementNames: [] }));
    await submitMountedUnits();
    expect(sessionStorage.getItem(unitStorageKey)).toBeNull();
    await screen.findByText(/expired/);
    await submitMountedUnits();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", `/api/browser-operations/${oldId}`,
      "/api/browser-operations/partition", "/api/settings/units/issue", "/api/settings/units"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[4][1]?.body))).toMatchObject({ operationId: newId });
  });
});
