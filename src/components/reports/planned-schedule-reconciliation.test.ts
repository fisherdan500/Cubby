// @vitest-environment jsdom
import React, { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => mocks }));
vi.mock("@/lib/browser-operation-tab-scope", () => ({ tabScopedBrowserOperationStorageKey: async (_p: string, key: string) => key }));
import { PlannedSchedulePanel } from "./planned-schedule";
globalThis.React = React;
const id = "bmo_0123456789abcdefghjkmnpqrs";
const partition = "a".repeat(64);
const key = `cubby:planned-schedule-operation:${partition}:baby`;
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status });
const partitionResponse = () => response({ version: 1, scope: "household", partition });
const issued = () => response({ status: "open", operationId: id, bindingId: "binding" });
const completed = () => response({ status: "completed", operationId: id, outcome: { operationId: id, kind: "planned_schedule", code: "ok", babyId: "baby", revision: 3, itemCount: 1 } });
const schedule = { babyId: "baby", revision: 2, canEdit: true, items: [{ kind: "wake" as const, label: null, timing: { mode: "exact" as const, at: "06:00" }, note: null }] };
const routine = { startKey: "2026-09-18", endKey: "2026-10-01", windowDays: 14, daysWithData: 14, enoughData: true,
  naps: null, feeds: null, timeline: [{ id: "wake", kind: "wake" as const, activityType: "sleep" as const, label: "Wake up", slot: { minutes: 420, time: "", spreadMinutes: 0, durationSeconds: null, duration: null, days: 14 } }] };
function open(mode: string) {
  render(createElement(PlannedSchedulePanel, { babyName: "Baby", schedule, routine }));
  fireEvent.click(screen.getByRole("button", { name: mode === "manual" ? "Edit plan" : "Suggest from routine" }));
  if (mode === "suggestion") {
    fireEvent.click(within(screen.getByRole("group", { name: "Wake up" })).getByLabelText("Edit, then accept"));
    fireEvent.change(screen.getByLabelText("At"), { target: { value: "07:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
  } else fireEvent.change(screen.getByLabelText("At"), { target: { value: "07:00" } });
}
const save = (mode: string) => fireEvent.click(screen.getByRole("button", { name: mode === "manual" ? "Save plan" : "Save to plan" }));
function change(mode: string) {
  if (mode === "suggestion") fireEvent.click(screen.getByRole("button", { name: "Back to suggestions" }));
  fireEvent.change(screen.getByLabelText("At"), { target: { value: "08:00" } });
  if (mode === "suggestion") fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
}
function expectDraft(mode: string) {
  if (mode === "manual") expect((screen.getByLabelText("At") as HTMLInputElement).value).toBe("08:00");
  else expect(screen.getByRole("list", { name: "Plan after these changes" }).textContent).toContain("8:00 AM");
  expect(mocks.refresh).not.toHaveBeenCalled();
}
beforeEach(() => { sessionStorage.clear(); mocks.refresh.mockReset(); });
afterEach(cleanup);

it.each(["manual", "suggestion"])("retires unknown completed %s A without claiming this draft", async (mode) => {
  const unknownId = "bmo_zzzzzzzzzzzzzzzzzzzzzzzzzz";
  sessionStorage.setItem(key, unknownId);
  globalThis.fetch = vi.fn().mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(response({ status: "completed", operationId: unknownId,
    outcome: { operationId: unknownId, kind: "planned_schedule", code: "ok", babyId: "baby", revision: 9, itemCount: 3 } }));
  open(mode); change(mode); save(mode); await screen.findByRole("alert");
  expectDraft(mode); expect(sessionStorage.getItem(key)).toBeNull(); expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});
it.each(["pending", "stale", "rejected", "expired"])("handles authoritative %s without issuing a replacement in the same click", async (status) => {
  sessionStorage.setItem(key, "bmo_zzzzzzzzzzzzzzzzzzzzzzzzzz");
  const code = status === "pending" ? "operation_unknown" : status === "stale" ? "stale_revision" : status === "rejected" ? "idempotency_conflict" : "operation_abandoned";
  globalThis.fetch = vi.fn().mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(response({ status, operationId: "bmo_zzzzzzzzzzzzzzzzzzzzzzzzzz", code }, status === "pending" ? 202 : status === "expired" ? 410 : 200));
  open("manual"); save("manual"); await screen.findByRole("alert");
  expect(sessionStorage.getItem(key)).toBe(status === "pending" ? "bmo_zzzzzzzzzzzzzzzzzzzzzzzzzz" : null);
  expect(screen.getByRole("button", { name: "Save plan" })).toBeTruthy(); expect(mocks.refresh).not.toHaveBeenCalled(); expect(globalThis.fetch).toHaveBeenCalledTimes(2);
});
it("compares normalized manual intent, not insignificant whitespace", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(issued()).mockRejectedValueOnce(new Error("lost"));
  globalThis.fetch = fetcher; open("manual");
  fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "A note" } }); save("manual"); await screen.findByRole("alert");
  fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: "  A note  " } });
  fetcher.mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(completed()); save("manual");
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce()); expect(sessionStorage.getItem(key)).toBeNull();
});


it.each(["manual", "suggestion"])("resubmits the same normalized %s plan after prepared lookup", async (mode) => {
  const fetcher = vi.fn().mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(issued()).mockRejectedValueOnce(new Error("lost"));
  globalThis.fetch = fetcher; open(mode); save(mode); await screen.findByRole("alert");
  fetcher.mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(response({ status: "prepared", operationId: id, code: "operation_prepared" }, 202)).mockResolvedValueOnce(completed());
  save(mode); await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[5][1]?.body).toBe(fetcher.mock.calls[2][1]?.body); expect(sessionStorage.getItem(key)).toBeNull();
});
it.each(["Add an item", "Remove item 1"])("does not discard %s during submit", async (button) => {
  let settle!: (response: Response) => void;
  globalThis.fetch = vi.fn().mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(issued()).mockReturnValueOnce(new Promise<Response>((resolve) => { settle = resolve; }));
  open("manual"); save("manual"); await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(3));
  fireEvent.click(screen.getByRole("button", { name: button })); await act(async () => settle(completed()));
  expect(screen.getByRole("button", { name: "Save plan" })).toBeTruthy(); expect(mocks.refresh).not.toHaveBeenCalled();
  expect(screen.queryAllByRole("group", { name: /^Item / })).toHaveLength(button === "Add an item" ? 2 : 0);
});


it.each(["manual", "suggestion"])("retains %s identity and draft for malformed submit and lookup receipts", async (mode) => {
  const malformed = [
    response({ status: "completed", operationId: id, outcome: {} }),
    response({ status: "completed", operationId: id, outcome: { kind: "planned_schedule", code: "ok", babyId: "baby", revision: 3, itemCount: 1 } }),
    response({ status: "completed", operationId: id, outcome: { operationId: "bmo_zzzzzzzzzzzzzzzzzzzzzzzzzz", kind: "planned_schedule", code: "ok", babyId: "baby", revision: 3, itemCount: 1 } }),
    response({ status: "completed", operationId: id, outcome: { operationId: "bmo_short", kind: "planned_schedule", code: "ok", babyId: "baby", revision: 3, itemCount: 1 } }),
    response({ status: "completed", operationId: id, outcome: { operationId: id, kind: "planned_schedule", code: "ok", babyId: "baby", revision: 3, itemCount: 1, extra: true } }),
    response({ status: "completed", operationId: id, outcome: { operationId: id, kind: "planned_schedule", code: "ok", babyId: "other", revision: 3, itemCount: 1 } }),
    response({ status: "completed", operationId: id, outcome: { operationId: id, kind: "planned_schedule", code: "ok", babyId: "baby", revision: 0, itemCount: 1 } }),
    response({ status: "completed", operationId: id, outcome: { operationId: id, kind: "planned_schedule", code: "ok", babyId: "baby", revision: 3, itemCount: 99 } }),
    response({ status: "completed", operationId: "bmo_zzzzzzzzzzzzzzzzzzzzzzzzzz", outcome: { operationId: id, kind: "planned_schedule", code: "ok", babyId: "baby", revision: 3, itemCount: 1 } }),
    response({ status: "stale", operationId: id, code: "bogus" }),
    response({ status: "rejected", operationId: id, code: "stale_revision" }),
    response({ status: "surprise", operationId: id }),
    response({ status: "completed", operationId: id, outcome: { operationId: id, kind: "planned_schedule", code: "ok", babyId: "baby", revision: 3, itemCount: 1 } }, 503),
    new Response("<html>proxy</html>", { status: 502 })
  ];
  for (const bad of malformed) {
    cleanup(); sessionStorage.clear();
    const fetcher = vi.fn().mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(issued()).mockResolvedValueOnce(bad.clone());
    globalThis.fetch = fetcher; open(mode); save(mode); await screen.findByRole("alert");
    expect(sessionStorage.getItem(key)).toBe(id); expect(mocks.refresh).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(bad.clone()); save(mode);
    await screen.findByRole("alert"); expect(sessionStorage.getItem(key)).toBe(id); expect(fetcher).toHaveBeenCalledTimes(5);
    fetcher.mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(completed()); save(mode);
    await waitFor(() => expect(sessionStorage.getItem(key)).toBeNull()); expect(mocks.refresh).toHaveBeenCalledOnce(); mocks.refresh.mockReset();
  }
});
it.each(["manual", "suggestion"])("does not submit unknown reloaded %s intent", async (mode) => {
  const unknownId = "bmo_zzzzzzzzzzzzzzzzzzzzzzzzzz";
  sessionStorage.setItem(key, unknownId);
  globalThis.fetch = vi.fn().mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(response({ status: "prepared", operationId: unknownId, code: "operation_prepared" }, 202));
  open(mode); save(mode); await screen.findByRole("alert");
  expect(globalThis.fetch).toHaveBeenCalledTimes(2); expect(sessionStorage.getItem(key)).toBe(unknownId);
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it.each(["manual", "suggestion"])("keeps newer %s B when lost A is confirmed", async (mode) => {
  const fetcher = vi.fn().mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(issued()).mockRejectedValueOnce(new Error("lost"));
  globalThis.fetch = fetcher; open(mode); save(mode); await screen.findByRole("alert");
  expect(sessionStorage.getItem(key)).toBe(id);
  expect(JSON.stringify(sessionStorage)).not.toContain("07:00");
  change(mode);
  fetcher.mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(completed()); save(mode);
  await waitFor(() => expect(sessionStorage.getItem(key)).toBeNull());
  expectDraft(mode);
  expect(screen.getByRole("alert").textContent).toMatch(/previous.*saved.*current.*not sent/i);
  expect(fetcher).toHaveBeenCalledTimes(5);
});
it("keeps manual edits made while A is in flight", async () => {
  let settle!: (response: Response) => void;
  globalThis.fetch = vi.fn().mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(issued()).mockReturnValueOnce(new Promise<Response>((resolve) => { settle = resolve; }));
  open("manual"); save("manual"); await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(3));
  change("manual"); await act(async () => settle(completed())); expectDraft("manual");
});
it.each(["manual", "suggestion"])("blocks changed %s intent under prepared A", async (mode) => {
  const fetcher = vi.fn().mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(issued()).mockRejectedValueOnce(new Error("lost"));
  globalThis.fetch = fetcher; open(mode); save(mode); await screen.findByRole("alert"); change(mode);
  fetcher.mockResolvedValueOnce(partitionResponse()).mockResolvedValueOnce(response({ status: "prepared", operationId: id, code: "operation_prepared" }, 202)); save(mode);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/unresolved/));
  expectDraft(mode); expect(sessionStorage.getItem(key)).toBe(id); expect(fetcher).toHaveBeenCalledTimes(5);
});
