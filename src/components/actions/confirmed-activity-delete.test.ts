// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));
import { ConfirmedActivityDelete } from "@/components/actions/confirmed-activity-delete";

globalThis.React = React;
const result = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;

beforeEach(() => { sessionStorage.clear(); vi.resetAllMocks(); });
afterEach(cleanup);

describe("ConfirmedActivityDelete", () => {
  const operationId = "bmo_0123456789abcdefghjkmnpqrs";
  const storageKey = "cubby:activity-delete-operation:household-a:activity-1:tab:test";
  const partition = result(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } });

  async function confirmAndDelete() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete activity" }));
    expect(screen.getByRole("region", { name: "Confirm activity deletion" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete activity" }));
  }

  it("mounts confirmation and submits the retained server-issued deletion ID", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));

    render(createElement(ConfirmedActivityDelete, { id: "activity-1", returnTo: "/app" }));
    await confirmAndDelete();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/app"));
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ operationId });
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("does not reuse an in-memory deletion after the mounted household partition changes", async () => {
    const partitionB = result(200, { ok: true, data: { version: 1, scope: "household", partition: "household-b" } });
    const operationIdB = "bmo_1123456789abcdefghjkmnpqrs";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "pending", operationId } }))
      .mockResolvedValueOnce(partitionB)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId: operationIdB } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId: operationIdB } }));
    globalThis.fetch = fetchMock;

    render(createElement(ConfirmedActivityDelete, { id: "activity-1", returnTo: "/app" }));
    await confirmAndDelete();
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Delete activity" }));

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/app"));
    expect(fetchMock.mock.calls.slice(3).map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      "/api/activities/activity-1?issue=1",
      "/api/activities/activity-1"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[5][1]?.body))).toEqual({ operationId: operationIdB });
    expect(fetchMock.mock.calls.slice(3).some(([url, init]) =>
      String(url).includes(operationId) || String(init?.body).includes(operationId)
    )).toBe(false);
  });

  it("resumes a retained prepared deletion with the same ID", async () => {
    sessionStorage.setItem(storageKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(202, { ok: true, data: { status: "prepared", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;

    render(createElement(ConfirmedActivityDelete, { id: "activity-1", returnTo: "/app" }));
    await confirmAndDelete();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/app"));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      `/api/browser-operations/${operationId}`,
      "/api/activities/activity-1"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ operationId });
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it.each([
    ["pending", 200, { ok: true, data: { status: "pending", operationId } }],
    ["404", 404, { ok: false, error: { code: "not_found" } }],
    ["unauthorized 410", 410, { ok: false, error: { code: "gone" } }],
    ["unknown", 200, { ok: true, data: { status: "unexpected", operationId } }],
    ["stale", 200, { ok: true, data: { status: "stale", operationId } }],
    ["rejected", 200, { ok: true, data: { status: "rejected", operationId } }]
  ])("retains a %s deletion without issuing a replacement", async (_label, status, body) => {
    sessionStorage.setItem(storageKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(status as number, body));
    globalThis.fetch = fetchMock;

    render(createElement(ConfirmedActivityDelete, { id: "activity-1", returnTo: "/app" }));
    await confirmAndDelete();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      `/api/browser-operations/${operationId}`
    ]);
    expect(sessionStorage.getItem(storageKey)).toBe(operationId);
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("clears a retained completed deletion", async () => {
    sessionStorage.setItem(storageKey, operationId);
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));

    render(createElement(ConfirmedActivityDelete, { id: "activity-1", returnTo: "/app" }));
    await confirmAndDelete();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/app"));
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("clears an authorized 410 deletion before issuing a replacement", async () => {
    const replacementId = "bmo_0123456789abcdefghjkmnpqrt";
    sessionStorage.setItem(storageKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(410, { ok: true, data: { status: "expired", operationId, code: "operation_result_expired" } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId: replacementId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId: replacementId } }));
    globalThis.fetch = fetchMock;

    render(createElement(ConfirmedActivityDelete, { id: "activity-1", returnTo: "/app" }));
    await confirmAndDelete();

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/app"));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      `/api/browser-operations/${operationId}`,
      "/api/activities/activity-1?issue=1",
      "/api/activities/activity-1"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({ operationId: replacementId });
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });
});
