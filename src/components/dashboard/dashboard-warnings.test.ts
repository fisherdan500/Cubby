// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));
import { DashboardWarnings } from "@/components/dashboard/dashboard-warnings";

globalThis.React = React;
const result = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;

beforeEach(() => { sessionStorage.clear(); mocks.refresh.mockReset(); });
afterEach(cleanup);

describe("DashboardWarnings", () => {
  it("mounts, hides the warning, and submits the server-issued dismissal ID", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(result(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;

    render(createElement(DashboardWarnings, { warnings: [{ type: "feeding", babyId: "baby-1", message: "Feeding is due", fingerprint: "feeding-v1" }] }));
    expect(screen.getByText("Feeding is due")).toBeTruthy();
    const dismiss = screen.getByRole("button", { name: "Dismiss warning" });
    expect(dismiss.className).toContain("h-11");
    expect(dismiss.className).toContain("w-11");
    await userEvent.click(dismiss);

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Feeding is due")).toBeNull();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      "/api/dashboard/warnings/dismiss/issue",
      "/api/dashboard/warnings/dismiss"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({ operationId, babyId: "baby-1", fingerprint: "feeding-v1" });
  });

  it("resumes a retained prepared warning reservation with the same ID", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    sessionStorage.setItem("cubby:dashboard-warning-operation:household-a:feeding:feeding-v1:tab:test", operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(result(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(result(202, { ok: true, data: { status: "prepared", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(DashboardWarnings, { warnings: [{ type: "feeding", babyId: "baby-1", message: "Feeding is due", fingerprint: "feeding-v1" }] }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", `/api/browser-operations/${operationId}`, "/api/dashboard/warnings/dismiss"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({ operationId });
  });

  it.each([
    ["pending", 200, { ok: true, data: { status: "pending", operationId: "bmo_0123456789abcdefghjkmnpqrs" } }],
    ["404", 404, { ok: false, error: { code: "not_found" } }],
    ["unknown", 200, { ok: true, data: { status: "unexpected", operationId: "bmo_0123456789abcdefghjkmnpqrs" } }],
    ["stale", 200, { ok: true, data: { status: "stale", operationId: "bmo_0123456789abcdefghjkmnpqrs" } }],
    ["rejected", 200, { ok: true, data: { status: "rejected", operationId: "bmo_0123456789abcdefghjkmnpqrs" } }],
    ["unauthorized 410", 410, { ok: false, error: { code: "gone" } }]
  ])("retains a %s warning reservation without submitting it", async (_label, status, body) => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const key = "cubby:dashboard-warning-operation:household-a:feeding:feeding-v1:tab:test";
    sessionStorage.setItem(key, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(result(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(result(status as number, body));
    globalThis.fetch = fetchMock;
    render(createElement(DashboardWarnings, { warnings: [{ type: "feeding", babyId: "baby-1", message: "Feeding is due", fingerprint: "feeding-v1" }] }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
    await screen.findByRole("alert");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition", `/api/browser-operations/${operationId}`
    ]);
    expect(sessionStorage.getItem(key)).toBe(operationId);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("clears only an exact authorized 410 warning result", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const key = "cubby:dashboard-warning-operation:household-a:feeding:feeding-v1:tab:test";
    sessionStorage.setItem(key, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(result(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(result(410, { ok: true, data: { status: "expired", operationId, code: "operation_result_expired" } }));
    globalThis.fetch = fetchMock;
    render(createElement(DashboardWarnings, { warnings: [{ type: "feeding", babyId: "baby-1", message: "Feeding is due", fingerprint: "feeding-v1" }] }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
    await screen.findByRole("alert");
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an in-memory warning operation after the partition changes", async () => {
    const operationIdA = "bmo_0123456789abcdefghjkmnpqrs";
    const operationIdB = "bmo_1123456789abcdefghjkmnpqrs";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(result(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId: operationIdA } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "stale", operationId: operationIdA, code: "stale_context" } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { version: 1, scope: "household", partition: "household-b" } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId: operationIdB } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId: operationIdB } }));
    globalThis.fetch = fetchMock;
    render(createElement(DashboardWarnings, { warnings: [{ type: "feeding", babyId: "baby-1", message: "Feeding is due", fingerprint: "feeding-v1" }] }));
    await userEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
    await waitFor(() => expect(screen.getByText("Feeding is due")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Dismiss warning" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      "/api/dashboard/warnings/dismiss/issue",
      "/api/dashboard/warnings/dismiss",
      "/api/browser-operations/partition",
      "/api/dashboard/warnings/dismiss/issue",
      "/api/dashboard/warnings/dismiss"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[5][1]?.body))).toMatchObject({ operationId: operationIdB });
  });
});
