// @vitest-environment jsdom
import React, { createElement, Fragment } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, replace: mocks.replace }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));
import { PauseTimerButton, ResumeTimerButton, StopTimerButton, UndoLastButton } from "@/components/actions/activity-actions";
import { ConfirmedActivityDelete } from "@/components/actions/confirmed-activity-delete";

globalThis.React = React;
const response = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
beforeEach(() => { sessionStorage.clear(); mocks.refresh.mockReset(); mocks.replace.mockReset(); });
afterEach(cleanup);

describe("durable immediate activity browser operations", () => {
  it("mounts every immediate timer and undo control", () => {
    render(createElement(Fragment, null,
      createElement(StopTimerButton, { id: "activity-1" }),
      createElement(PauseTimerButton, { id: "activity-1" }),
      createElement(ResumeTimerButton, { id: "activity-1" }),
      createElement(UndoLastButton)
    ));

    for (const name of ["Stop timer", "Pause", "Resume", "Undo last"]) expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it.each([
    ["stop", StopTimerButton, { id: "activity-1" }, "Stop timer", "/api/timers/activity-1/stop"],
    ["pause", PauseTimerButton, { id: "activity-1" }, "Pause", "/api/timers/activity-1/pause"],
    ["resume", ResumeTimerButton, { id: "activity-1" }, "Resume", "/api/timers/activity-1/resume"],
    ["undo", UndoLastButton, {}, "Undo last", "/api/activities/undo-last"]
  ])("submits a server-issued open %s reservation with the same ID", async (_name, Component, props, label, endpoint) => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    render(createElement(Component as React.ComponentType<Record<string, unknown>>, props));
    await userEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      `${endpoint}?issue=1`,
      endpoint
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ operationId });
  });

  it("mounts deletion and enters its named confirmation state", async () => {
    render(createElement(ConfirmedActivityDelete, { id: "activity-1", returnTo: "/app" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete activity" }));

    expect(screen.getByRole("region", { name: "Confirm activity deletion" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep activity" })).toBeTruthy();
  });
});
