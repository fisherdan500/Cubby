// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_partition: string, key: string) => `${key}:tab:test` }));

import { PlannedSchedulePanel } from "@/components/reports/planned-schedule";

globalThis.React = React;
const response = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
const operationId = "bmo_0123456789abcdefghjkmnpqrs";

beforeEach(() => { sessionStorage.clear(); mocks.refresh.mockReset(); });
afterEach(cleanup);

const plan = {
  babyId: "baby-1",
  revision: 2,
  canEdit: true,
  items: [
    { kind: "wake" as const, label: null, timing: { mode: "exact" as const, at: "06:30" }, note: null },
    { kind: "nap" as const, label: null, timing: { mode: "window" as const, from: "09:30", to: "10:00" }, note: "Crib, white noise on" }
  ]
};

function renderPanel(schedule = plan) {
  render(createElement(PlannedSchedulePanel, { babyName: "Avery", schedule }));
}

describe("PlannedSchedulePanel", () => {
  it("shows the plan as written, marked as a plan", () => {
    renderPanel();
    const items = within(screen.getByRole("list", { name: "Planned schedule" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("6:30 AMWake up"),
      expect.stringContaining("9:30 AM to 10:00 AMNapCrib, white noise on")
    ]);
    expect(screen.getByText(/planned, not what happened/i)).toBeTruthy();
  });

  it("invites a first plan only from someone who may write one", () => {
    renderPanel({ ...plan, revision: 0, items: [] });
    expect(screen.getByRole("button", { name: "Create a plan" })).toBeTruthy();
    cleanup();
    renderPanel({ ...plan, revision: 0, items: [], canEdit: false });
    expect(screen.queryByRole("button", { name: "Create a plan" })).toBeNull();
    expect(screen.getByText(/No plan yet/)).toBeTruthy();
  });

  it("saves an edited plan through a server-issued operation, from the revision it was opened on", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Add an item" }));
    const rows = screen.getAllByRole("group", { name: /^Item \d+$/ });
    const added = rows[rows.length - 1];
    fireEvent.change(within(added).getByLabelText("What"), { target: { value: "bedtime" } });
    fireEvent.change(within(added).getByLabelText("At"), { target: { value: "19:15" } });
    fireEvent.click(screen.getByRole("button", { name: "Save plan" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/browser-operations/partition",
      "/api/babies/baby-1/schedule?issue=1",
      "/api/babies/baby-1/schedule"
    ]);
    const saved = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(saved).toMatchObject({ operationId, expectedRevision: 2 });
    expect(saved.items.map((item: { kind: string }) => item.kind)).toEqual(["wake", "nap", "bedtime"]);
    expect(sessionStorage.getItem("cubby:planned-schedule-operation:household-a:baby-1:tab:test")).toBeNull();
  });

  it("explains a plan that cannot be saved before sending it", () => {
    globalThis.fetch = vi.fn();
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Add an item" }));
    const rows = screen.getAllByRole("group", { name: /^Item \d+$/ });
    fireEvent.change(within(rows[rows.length - 1]).getByLabelText("What"), { target: { value: "custom" } });
    fireEvent.click(screen.getByRole("button", { name: "Save plan" }));

    expect(screen.getByRole("alert").textContent).toMatch(/needs a name/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("says so when someone else changed the plan meanwhile, rather than overwriting it", async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(409, { ok: false, error: { code: "stale_revision", message: "changed" } }));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Save plan" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/changed this plan/));
  });

  it("prints the plan on its own", () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Print plan" }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.print).toBe("plan");
    window.dispatchEvent(new Event("afterprint"));
    expect(document.documentElement.dataset.print).toBeUndefined();
    print.mockRestore();
  });
});
