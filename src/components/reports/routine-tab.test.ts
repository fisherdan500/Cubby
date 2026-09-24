// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addDaysToDateKey, zonedDateTimeToDate } from "@/lib/timezone";
import { buildRoutine } from "@/server/services/reports";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), usePathname: () => "/app/reports" }));

import { RoutineTab } from "@/components/reports/routine-tab";

globalThis.React = React;
afterEach(cleanup);

const timeZone = "UTC";
const at = (key: string, time: string) => zonedDateTimeToDate(`${key}T${time}`, timeZone);

function week(days = 7, nightBefore = true) {
  const records = [];
  for (let offset = nightBefore ? -1 : 0; offset < days; offset += 1) {
    const key = addDaysToDateKey("2026-09-14", offset);
    const next = addDaysToDateKey(key, 1);
    const record = (type: string, start: Date, end: Date | null) => ({ type, occurredAt: start, startedAt: start, endedAt: end, durationSeconds: null });
    if (offset >= 0) {
      records.push(record("sleep", at(key, "09:30"), at(key, "10:40")));
      records.push(record("sleep", at(key, "13:30"), at(key, "15:15")));
      for (const time of ["06:40", "10:00", "13:00", "16:10", "18:50"]) records.push(record("feeding", at(key, time), null));
    }
    records.push(record("sleep", at(key, "19:15"), at(next, "06:30")));
  }
  return buildRoutine(records, addDaysToDateKey("2026-09-14", days - 1), "1w", timeZone);
}

function renderTab(routine = week()) {
  render(createElement(RoutineTab, { babyId: "baby-1", babyName: "Avery", startKey: "2026-09-14", endKey: "2026-09-20", routine }));
}

describe("RoutineTab", () => {
  it("leads with the day's anchors: wake, bedtime, naps and feeds", () => {
    renderTab();
    const facts = screen.getByRole("list", { name: "Routine at a glance" });

    expect(within(facts).getByText("Wakes up").parentElement?.textContent).toContain("6:30 AM");
    expect(within(facts).getByText("Bedtime").parentElement?.textContent).toContain("7:15 PM");
    expect(within(facts).getByText("Naps").parentElement?.textContent).toContain("2 a day");
    expect(within(facts).getByText("Feeds").parentElement?.textContent).toContain("every 3h");
  });

  it("lists the typical day in order, as something a caregiver could follow", () => {
    renderTab();
    const items = within(screen.getByRole("list", { name: "Typical day" })).getAllByRole("listitem");

    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("6:30 AMWake up"),
      expect.stringContaining("6:40 AMFeed"),
      expect.stringContaining("9:30 AMNap 1"),
      expect.stringContaining("10:00 AMFeed"),
      expect.stringContaining("1:00 PMFeed"),
      expect.stringContaining("1:30 PMNap 2"),
      expect.stringContaining("4:10 PMFeed"),
      expect.stringContaining("6:50 PMFeed"),
      expect.stringContaining("7:15 PMBedtime")
    ]);
  });

  it("says plainly when there is not enough logged yet, rather than inventing a routine", () => {
    renderTab(week(2, false));
    expect(screen.getByText(/Not enough logged yet/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Typical day" })).toBeNull();
  });

  it("prints with a heading that says this is what happened, not a plan", () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Print routine" }));

    expect(print).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.print).toBe("routine");
    expect(screen.getByText("Avery's routine")).toBeTruthy();
    expect(screen.getByText(/what happened, not a plan/)).toBeTruthy();
    print.mockRestore();
  });
});
