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

describe("suggesting a plan from the routine", () => {
  const slot = (minutes: number, spreadMinutes: number, days: number) => ({ minutes, time: "", spreadMinutes, durationSeconds: null, duration: null, days });
  const routine = {
    startKey: "2026-09-18",
    endKey: "2026-10-01",
    windowDays: 14,
    daysWithData: 14,
    enoughData: true,
    naps: { usualCount: 1, daysWithUsualCount: 11, daysCounted: 14, minCount: 1, maxCount: 2, slots: [] },
    feeds: null,
    timeline: [
      { id: "wake", kind: "wake" as const, activityType: "sleep" as const, label: "Wake up", slot: slot(7 * 60, 5, 14) },
      { id: "nap-0", kind: "nap" as const, activityType: "sleep" as const, label: "Nap", slot: slot(9 * 60 + 30, 30, 11) },
      { id: "bedtime", kind: "bedtime" as const, activityType: "sleep" as const, label: "Bedtime", slot: slot(19 * 60 + 12, 15, 13) }
    ]
  };

  function renderWithRoutine(schedule = plan, withRoutine: typeof routine | undefined = routine) {
    render(createElement(PlannedSchedulePanel, { babyName: "Avery", schedule, routine: withRoutine }));
  }

  it("offers suggestions only to someone who may edit, and only when there is a routine", () => {
    renderWithRoutine();
    expect(screen.getByRole("button", { name: "Suggest from routine" })).toBeTruthy();
    cleanup();
    renderWithRoutine({ ...plan, canEdit: false });
    expect(screen.queryByRole("button", { name: "Suggest from routine" })).toBeNull();
    cleanup();
    renderWithRoutine(plan, { ...routine, enoughData: false, timeline: [] });
    expect(screen.queryByRole("button", { name: "Suggest from routine" })).toBeNull();
  });

  it("shows each suggestion with its evidence and confidence, undecided until a choice is made", () => {
    renderWithRoutine();
    fireEvent.click(screen.getByRole("button", { name: "Suggest from routine" }));

    const nap = screen.getByRole("group", { name: "Nap" });
    expect(nap.textContent).toMatch(/9:00 AM to 10:00 AM/);
    expect(nap.textContent).toMatch(/Now in your plan: 9:30 AM to 10:00 AM/);
    expect(nap.textContent).toMatch(/Seen on 11 of 14 days/);
    expect(nap.textContent).toMatch(/3 days left out/);
    expect(nap.textContent).toMatch(/Fairly steady/);
    expect((within(nap).getByLabelText("Decide later") as HTMLInputElement).checked).toBe(true);
    // Nothing is chosen for anyone, so there is nothing to review yet.
    expect((screen.getByRole("button", { name: "Review changes" }) as HTMLButtonElement).disabled).toBe(true);
    // Suggested from observations, not advice.
    expect(screen.getByText(/from what was logged/i)).toBeTruthy();
  });

  it("previews exactly the resulting plan, then saves only the accepted changes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { ok: true, data: { version: 1, scope: "household", partition: "household-a" } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "open", operationId } }))
      .mockResolvedValueOnce(response(200, { ok: true, data: { status: "completed", operationId } }));
    globalThis.fetch = fetchMock;
    renderWithRoutine();
    fireEvent.click(screen.getByRole("button", { name: "Suggest from routine" }));

    fireEvent.click(within(screen.getByRole("group", { name: "Nap" })).getByLabelText("Reject"));
    const bedtime = screen.getByRole("group", { name: "Bedtime" });
    fireEvent.click(within(bedtime).getByLabelText("Edit, then accept"));
    fireEvent.change(within(bedtime).getByLabelText("When"), { target: { value: "exact" } });
    fireEvent.change(within(bedtime).getByLabelText("At"), { target: { value: "19:15" } });
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));

    const preview = screen.getByRole("list", { name: "Plan after these changes" });
    expect(within(preview).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("6:30 AMWake up"),
      expect.stringContaining("9:30 AM to 10:00 AMNap"),
      expect.stringMatching(/7:15 PMBedtime.*New/)
    ]);
    expect(screen.getByText(/1 added, 0 changed, 1 rejected, 1 left undecided/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save to plan" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(body).toMatchObject({ expectedRevision: 2 });
    expect(body.items.map((item: { kind: string; timing: unknown }) => [item.kind, item.timing])).toEqual([
      ["wake", { mode: "exact", at: "06:30" }],
      ["nap", { mode: "window", from: "09:30", to: "10:00" }],
      ["bedtime", { mode: "exact", at: "19:15" }]
    ]);
  });

  it("can be put away without changing anything", () => {
    globalThis.fetch = vi.fn();
    renderWithRoutine();
    fireEvent.click(screen.getByRole("button", { name: "Suggest from routine" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Nap" })).getByLabelText("Accept"));
    fireEvent.click(screen.getByRole("button", { name: "Close suggestions" }));
    expect(screen.queryByRole("group", { name: "Nap" })).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
