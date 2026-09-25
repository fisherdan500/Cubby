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

const periods = [
  { label: "7 days", href: "/app/reports?tab=routine&routineWindow=1w", current: true },
  { label: "14 days", href: "/app/reports?tab=routine&routineWindow=2w", current: false },
  { label: "30 days", href: "/app/reports?tab=routine&routineWindow=1m", current: false }
];

function renderTab(routine = week()) {
  render(createElement(RoutineTab, { babyName: "Avery", routine, periods }));
}

describe("RoutineTab", () => {
  it("offers one choice of period, marking the one in use", () => {
    renderTab();
    const links = within(screen.getByRole("navigation", { name: "Routine period" })).getAllByRole("link");

    expect(links.map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("aria-current")])).toEqual([
      ["7 days", periods[0].href, "true"],
      ["14 days", periods[1].href, null],
      ["30 days", periods[2].href, null]
    ]);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("sums the day up in a line above the list, with only what the list does not show", () => {
    renderTab();
    const summary = screen.getByText(/naps a day/);

    expect(summary.textContent).toMatch(/^Night about \d/);
    expect(summary.textContent).toContain("2 naps a day on 7 of 7 days");
    expect(summary.textContent).toContain("about 5 feeds by day, roughly every 3h");
    // The four big cards repeated the list's own times; they are gone.
    expect(screen.queryByRole("list", { name: "Routine at a glance" })).toBeNull();
    expect(screen.getByRole("list", { name: "Typical day" }).closest("section")?.contains(summary)).toBe(true);
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

  it("suggests a plan from this very routine, starting with each of its steady times", () => {
    const routine = week();
    render(createElement(RoutineTab, {
      babyName: "Avery", routine, periods,
      schedule: { babyId: "baby-1", revision: 0, canEdit: true, items: [] }
    }));

    fireEvent.click(screen.getByRole("button", { name: "Suggest from routine" }));
    const suggested = screen.getAllByRole("group").map((group) => group.getAttribute("aria-label"));
    expect(suggested).toEqual(["Wake up", "Feed", "Nap 1", "Feed", "Feed", "Nap 2", "Feed", "Feed", "Bedtime"]);
    expect(screen.getByRole("group", { name: "Wake up" }).textContent).toMatch(/6:30 AM/);
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
