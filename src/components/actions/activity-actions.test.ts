// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));
import { PauseTimerButton, ResumeTimerButton, StopTimerButton } from "@/components/actions/activity-actions";

globalThis.React = React;
const result = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;

beforeEach(() => { sessionStorage.clear(); mocks.refresh.mockReset(); mocks.replace.mockReset(); });
afterEach(cleanup);

describe("activity action browser-v2 handling", () => {
  const operationId = "bmo_0123456789abcdefghjkmnpqrs";
  const storageKey = "cubby:activity-operation:household-a:timer.stop:timer-1:tab:test";
  const partition = result(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } });

  it("mounts a timer action and submits the server-issued partitioned reservation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;

    render(createElement(StopTimerButton, { id: "timer-1" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop timer" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      "/api/timers/timer-1/stop?issue=1",
      "/api/timers/timer-1/stop"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ operationId });
    // Stopping from the shell's timer bar leaves you where you are: no return destination is given.
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("announces an authoritative timer change so shell chrome can refetch immediately", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    const changes = vi.fn();
    window.addEventListener("cubby:active-timers-changed", changes);

    try {
      render(createElement(StopTimerButton, { id: "timer-1" }));
      await userEvent.click(screen.getByRole("button", { name: "Stop timer" }));
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));

      expect(changes).toHaveBeenCalledTimes(1);
      expect((changes.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ timerId: "timer-1", operation: "stop" });
    } finally {
      window.removeEventListener("cubby:active-timers-changed", changes);
    }
  });

  it.each([
    ["stop", StopTimerButton, "Stop timer"],
    ["pause", PauseTimerButton, "Pause"],
    ["resume", ResumeTimerButton, "Resume"]
  ] as const)("announces an authoritative %s completion", async (operation, Component, label) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    const changes = vi.fn();
    window.addEventListener("cubby:active-timers-changed", changes);

    try {
      render(createElement(Component, { id: "timer-1" }));
      await userEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));

      expect(changes).toHaveBeenCalledTimes(1);
      expect((changes.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ timerId: "timer-1", operation });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "/api/browser-operations/partition",
        `/api/timers/timer-1/${operation}?issue=1`,
        `/api/timers/timer-1/${operation}`
      ]);
    } finally {
      window.removeEventListener("cubby:active-timers-changed", changes);
    }
  });

  it.each([
    ["stop", StopTimerButton, "Stop timer"],
    ["pause", PauseTimerButton, "Pause"],
    ["resume", ResumeTimerButton, "Resume"]
  ] as const)("announces a reconciled %s completion", async (operation, Component, label) => {
    const retainedKey = `cubby:activity-operation:household-a:timer.${operation}:timer-1:tab:test`;
    sessionStorage.setItem(retainedKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    const changes = vi.fn();
    window.addEventListener("cubby:active-timers-changed", changes);

    try {
      render(createElement(Component, { id: "timer-1" }));
      await userEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));

      expect(changes).toHaveBeenCalledTimes(1);
      expect((changes.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ timerId: "timer-1", operation });
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        "/api/browser-operations/partition",
        `/api/browser-operations/${operationId}`
      ]);
      expect(sessionStorage.getItem(retainedKey)).toBeNull();
    } finally {
      window.removeEventListener("cubby:active-timers-changed", changes);
    }
  });

  it("returns to where the activity was opened from once its timer is stopped", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;

    render(createElement(StopTimerButton, { id: "timer-1", returnTo: "/app?babyId=baby-1" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop timer" }));

    // Stopping is the end of that activity's business, so the screen goes back by itself rather than
    // leaving a stopped timer on display with a Back press still to make.
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/app?babyId=baby-1"));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("returns only after the stop is authoritatively complete", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "pending", operationId } }));
    globalThis.fetch = fetchMock;

    render(createElement(StopTimerButton, { id: "timer-1", returnTo: "/app?babyId=baby-1" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop timer" }));

    // An unknown outcome keeps you on the activity, where the error and a retry are.
    await screen.findByRole("alert");
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("returns when a retried stop turns out to have completed already", async () => {
    sessionStorage.setItem(storageKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;

    render(createElement(StopTimerButton, { id: "timer-1", returnTo: "/app/history" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop timer" }));

    // The reconciliation path has to return too, or a retry after a lost response would strand you.
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/app/history"));
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("does not reuse an in-memory timer operation after the mounted household partition changes", async () => {
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

    render(createElement(StopTimerButton, { id: "timer-1" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop timer" }));
    await screen.findByRole("alert");
    await userEvent.click(screen.getByRole("button", { name: "Stop timer" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.slice(3).map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      "/api/timers/timer-1/stop?issue=1",
      "/api/timers/timer-1/stop"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[5][1]?.body))).toEqual({ operationId: operationIdB });
    expect(fetchMock.mock.calls.slice(3).some(([url, init]) =>
      String(url).includes(operationId) || String(init?.body).includes(operationId)
    )).toBe(false);
  });

  it("resumes a retained prepared timer operation with the same ID", async () => {
    sessionStorage.setItem(storageKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(202, { ok: true, data: { status: "prepared", operationId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;

    render(createElement(StopTimerButton, { id: "timer-1" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop timer" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      `/api/browser-operations/${operationId}`,
      "/api/timers/timer-1/stop"
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
  ])("retains a %s timer operation without issuing a replacement", async (_label, status, body) => {
    sessionStorage.setItem(storageKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(status as number, body));
    globalThis.fetch = fetchMock;

    render(createElement(StopTimerButton, { id: "timer-1" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop timer" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      `/api/browser-operations/${operationId}`
    ]);
    expect(sessionStorage.getItem(storageKey)).toBe(operationId);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("clears a retained completed timer operation", async () => {
    sessionStorage.setItem(storageKey, operationId);
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId } }));

    render(createElement(StopTimerButton, { id: "timer-1" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop timer" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });

  it("clears an authorized 410 timer operation before issuing a replacement", async () => {
    const replacementId = "bmo_0123456789abcdefghjkmnpqrt";
    sessionStorage.setItem(storageKey, operationId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(partition)
      .mockResolvedValueOnce(result(410, { ok: true, data: { status: "expired", operationId, code: "operation_result_expired" } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "open", operationId: replacementId } }))
      .mockResolvedValueOnce(result(200, { ok: true, data: { status: "completed", operationId: replacementId } }));
    globalThis.fetch = fetchMock;

    render(createElement(StopTimerButton, { id: "timer-1" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop timer" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      `/api/browser-operations/${operationId}`,
      "/api/timers/timer-1/stop?issue=1",
      "/api/timers/timer-1/stop"
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({ operationId: replacementId });
    expect(sessionStorage.getItem(storageKey)).toBeNull();
  });
});
