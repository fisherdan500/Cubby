// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));
import { BabyLifecycleButton } from "@/components/actions/baby-lifecycle-button";

globalThis.React = React;
const result = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;

beforeEach(() => { sessionStorage.clear(); mocks.refresh.mockReset(); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("BabyLifecycleButton", () => {
  const operationId = "bmo_0123456789abcdefghjkmnpqrs";
  const storageKey = "cubby:baby-lifecycle-operation:household-a:baby-1:tab:test";
  const retained = JSON.stringify({ operationId, action: "deactivate" });
  const partition = result(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } });

  it("mounts and submits a server-issued partitioned lifecycle reservation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;

    render(createElement(BabyLifecycleButton, { babyId: "baby-1", babyName: "Avery", inactive: false }));
    await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      "/api/babies/baby-1/deactivate?issue=1",
      "/api/babies/baby-1/deactivate"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ operationId });
  });

  it.each([
    ["pending", 202],
    ["stale", 200],
    ["rejected", 200],
    ["expired", 410],
    ["unknown", 200]
  ])("does not retain or submit a newly issued %s lifecycle result", async (status, httpStatus) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(httpStatus, { ok: true, data: { status, operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(BabyLifecycleButton, { babyId: "baby-1", babyName: "Avery", inactive: false }));
    await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    await screen.findByRole("alert");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      "/api/babies/baby-1/deactivate?issue=1"
    ]);
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("does not reuse an in-memory lifecycle operation after the mounted household partition changes", async () => {
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

    render(createElement(BabyLifecycleButton, { babyId: "baby-1", babyName: "Avery", inactive: false }));
    await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.slice(3).map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      "/api/babies/baby-1/deactivate?issue=1",
      "/api/babies/baby-1/deactivate"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[5][1]?.body))).toEqual({ operationId: operationIdB });
    expect(fetchMock.mock.calls.slice(3).some(([url, init]) =>
      String(url).includes(operationId) || String(init?.body).includes(operationId)
    )).toBe(false);
  });

  it("resumes a retained prepared lifecycle operation with the same ID and action", async () => {
    sessionStorage.setItem(storageKey, retained);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(202, { ok: true, data: { status: "prepared", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;

    render(createElement(BabyLifecycleButton, { babyId: "baby-1", babyName: "Avery", inactive: false }));
    await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      `/api/browser-operations/${operationId}`,
      "/api/babies/baby-1/deactivate"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ operationId });
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it.each([
    ["pending", 200, { ok: true, data: { status: "pending", operationId } }],
    ["404", 404, { ok: false, error: { code: "not_found" } }],
    ["unknown", 200, { ok: true, data: { status: "unexpected", operationId } }],
    ["stale", 200, { ok: true, data: { status: "stale", operationId } }],
    ["rejected", 200, { ok: true, data: { status: "rejected", operationId } }]
  ])("retains a %s lifecycle operation without issuing a replacement", async (_label, status, body) => {
    sessionStorage.setItem(storageKey, retained);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(status as number, body));
    globalThis.fetch = fetchMock;

    render(createElement(BabyLifecycleButton, { babyId: "baby-1", babyName: "Avery", inactive: false }));
    await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      `/api/browser-operations/${operationId}`
    ]);
    expect(sessionStorage.getItem(storageKey)).toBe(retained);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("clears a retained completed lifecycle operation", async () => {
    sessionStorage.setItem(storageKey, retained);
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));

    render(createElement(BabyLifecycleButton, { babyId: "baby-1", babyName: "Avery", inactive: false }));
    await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("clears an authorized 410 lifecycle operation before issuing a replacement", async () => {
    const replacementId = "bmo_0123456789abcdefghjkmnpqrt";
    sessionStorage.setItem(storageKey, retained);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(410, { ok: true, data: { status: "expired", operationId, code: "operation_result_expired" } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId: replacementId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId: replacementId } }));
    globalThis.fetch = fetchMock;

    render(createElement(BabyLifecycleButton, { babyId: "baby-1", babyName: "Avery", inactive: false }));
    await userEvent.click(screen.getByRole("button", { name: "Deactivate" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      `/api/browser-operations/${operationId}`,
      "/api/babies/baby-1/deactivate?issue=1",
      "/api/babies/baby-1/deactivate"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({ operationId: replacementId });
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });
});
