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

globalThis.React = React;
const response = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  sessionStorage.clear();
  mocks.push.mockReset(); mocks.replace.mockReset(); mocks.refresh.mockReset();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { cleanup(); consoleError.mockRestore(); });

function renderActivity(activityId?: string) {
  render(createElement(ActivityForm, {
    babies: [{ id: "baby-1", name: "Avery" }], type: "note", selectedBabyId: "baby-1", activityId,
    initial: activityId ? { babyId: "baby-1", notes: "Existing", updatedAt: "2026-08-21T00:00:00.000Z" } : undefined,
    successTo: "/done", appTimeZone: "UTC", unitPreferences: defaultUnitPreferences, medicineNames: [], supplementNames: []
  }));
}

async function submitMountedActivity(activityId?: string) {
  const form = screen.getByRole("button", { name: activityId ? "Save changes" : "Log activity" }).closest("form") as HTMLFormElement;
  const key = Object.keys(form).find((value) => value.startsWith("__reactProps$"));
  const props = (form as unknown as Record<string, { action: (data: FormData) => Promise<void> }>)[key!];
  await act(async () => { await props.action(new FormData(form)); });
}

describe("ActivityForm browser-v2 handling", () => {
  it("mounts a create form and updates its browser-controlled fields", async () => {
    render(createElement(ActivityForm, {
      babies: [{ id: "baby-1", name: "Avery" }],
      type: "note",
      selectedBabyId: "baby-1",
      appTimeZone: "UTC",
      unitPreferences: defaultUnitPreferences,
      medicineNames: [],
      supplementNames: []
    }));
    const note = screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;

    await userEvent.type(note, "Mounted carrier note");

    expect(note.value).toBe("Mounted carrier note");
    expect((screen.getByRole("combobox", { name: "Baby" }) as HTMLSelectElement).value).toBe("baby-1");
    expect(screen.getByRole("button", { name: "Log activity" })).toBeTruthy();
  });

  it.each([
    { label: "create", activityId: undefined, initial: undefined, endpoint: "/api/activities", storageKey: "cubby:activity-form-operation:household-a:create:note:tab:test" },
    { label: "update", activityId: "activity-1", initial: { babyId: "baby-1", notes: "Existing", updatedAt: "2026-08-21T00:00:00.000Z" }, endpoint: "/api/activities/activity-1", storageKey: "cubby:activity-form-operation:household-a:activity-1:tab:test" }
  ])("submits an open $label reservation with the same server ID", async ({ activityId, initial, endpoint, storageKey }) => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(ActivityForm, {
      babies: [{ id: "baby-1", name: "Avery" }], type: "note", selectedBabyId: "baby-1", activityId, initial,
      successTo: "/done", appTimeZone: "UTC", unitPreferences: defaultUnitPreferences, medicineNames: [], supplementNames: []
    }));
    const form = screen.getByRole("button", { name: activityId ? "Save changes" : "Log activity" }).closest("form") as HTMLFormElement;
    const reactPropsKey = Object.keys(form).find((key) => key.startsWith("__reactProps$"));
    const props = (form as unknown as Record<string, { action: (data: FormData) => Promise<void> }>)[reactPropsKey!];
    await act(async () => { await props.action(new FormData(form)); });
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", `${endpoint}?issue=1`, endpoint
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({ operationId, babyId: "baby-1", type: "note" });
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it.each([
    { label: "create", activityId: undefined, endpoint: "/api/activities" },
    { label: "update", activityId: "activity-1", endpoint: "/api/activities/activity-1" }
  ])("resumes a retained prepared $label reservation with the same ID", async ({ activityId, endpoint }) => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const key = `cubby:activity-form-operation:household-a:${activityId ?? "create:note"}:tab:test`;
    sessionStorage.setItem(key, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(202, { ok: true, data: { status: "prepared", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    renderActivity(activityId);
    await submitMountedActivity(activityId);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", `/api/browser-operations/${operationId}`, endpoint
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({ operationId });
  });

  it.each([
    { label: "create pending", activityId: undefined, status: 200, body: { ok: true, data: { status: "pending", operationId: "bmo_0123456789abcdefghjkmnpqrs" } } },
    { label: "create 404", activityId: undefined, status: 404, body: { ok: false, error: { code: "not_found" } } },
    { label: "update pending", activityId: "activity-1", status: 200, body: { ok: true, data: { status: "pending", operationId: "bmo_0123456789abcdefghjkmnpqrs" } } },
    { label: "update 404", activityId: "activity-1", status: 404, body: { ok: false, error: { code: "not_found" } } }
  ])("retains an existing $label reservation without replacement", async ({ activityId, status, body }) => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const key = `cubby:activity-form-operation:household-a:${activityId ?? "create:note"}:tab:test`;
    sessionStorage.setItem(key, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(status, body));
    globalThis.fetch = fetchMock;
    renderActivity(activityId);
    await submitMountedActivity(activityId);
    await screen.findByRole("alert");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", `/api/browser-operations/${operationId}`
    ]);
    expect(sessionStorage.getItem(key)).toBe(operationId);
  });

  it.each([
    { label: "create", activityId: undefined, endpoint: "/api/activities" },
    { label: "update", activityId: "activity-1", endpoint: "/api/activities/activity-1" }
  ])("clears an authorized 410 and submits a replacement $label ID", async ({ activityId, endpoint }) => {
    const oldId = "bmo_0123456789abcdefghjkmnpqrs";
    const newId = "bmo_1123456789abcdefghjkmnpqrs";
    const key = `cubby:activity-form-operation:household-a:${activityId ?? "create:note"}:tab:test`;
    sessionStorage.setItem(key, oldId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(410, { ok: true, data: { status: "expired", operationId: oldId, code: "operation_result_expired" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId: newId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId: newId } }));
    globalThis.fetch = fetchMock;
    renderActivity(activityId);
    await submitMountedActivity(activityId);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", `/api/browser-operations/${oldId}`, `${endpoint}?issue=1`, endpoint
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toMatchObject({ operationId: newId });
    expect(sessionStorage.getItem(key)).toBeNull();
  });
});
