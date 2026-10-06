// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { TrendsTab } from "@/components/reports/trends-tab";
import type { TrendPoint, Trends } from "@/server/services/trends";

afterEach(cleanup);

const panels = [
  ["sleep", "Total sleep per day", "sleep", "1h 30m", "2h"],
  ["daytimeSleep", "Daytime sleep per day (7 AM–7 PM)", "sleep", "1h 30m", "2h"],
  ["nighttimeSleep", "Nighttime sleep per day (7 PM–7 AM)", "sleep", "1h 30m", "2h"],
  ["feeds", "Feeds per day", "feeding", "5.0", "7.0"],
  ["volume", "Bottle and formula per day", "feeding", "5.0 oz", "7.0 oz"],
  ["diapers", "Diapers per day", "diaper", "5.0", "7.0"],
  ["wetDiapers", "Wet diapers per day", "diaper", "5.0", "7.0"],
  ["dirtyDiapers", "Dirty diapers per day", "diaper", "5.0", "7.0"]
] as const;
const babyId = "baby /?&=Avery";

function point(weekKey: string, value: number | null, daysCounted = 7, daysLogged = 7, daysUnknown = 0): TrendPoint {
  return { weekKey, value, daysCounted, daysLogged, daysUnknown };
}

function report(): Trends {
  return {
    startKey: "2025-12-29", endKey: "2026-01-25", weeks: 4, anyData: true,
    ...Object.fromEntries(panels.map(([key, , type]) => [key, {
      points: [
        point("2025-12-29", type === "sleep" ? 7200 : 7, 3, 4, 1),
        point("2026-01-05", null, 0, 2, 2),
        point("2026-01-12", type === "sleep" ? 5400 : 5, 6, 7),
        point("2026-01-19", null, 0, 0)
      ], daysCounted: 9
    }]))
  } as Trends;
}

function view(trends = report()) {
  return <TrendsTab babyId={babyId} babyName="Avery" trends={trends} periods={[]} />;
}

function expectLink(detail: HTMLElement, type: string, week: string) {
  const link = within(detail).getByRole("link", { name: `View ${type} records in this week` });
  const url = new URL(link.getAttribute("href")!, "https://cubby.example.test");
  expect(url.pathname).toBe("/app/history");
  expect([...url.searchParams.entries()]).toEqual([["babyId", babyId], ["type", type], ["week", week]]);
}

describe("TrendsTab week selection", () => {
  it.each([false, true])("resets a removed selection to the new window default (all blank: %s)", async (allBlank) => {
    const user = userEvent.setup();
    const { rerender } = render(view());
    const selector = screen.getByRole("combobox", { name: "Feeds per day: week" }) as HTMLSelectElement;
    await user.selectOptions(selector, "2025-12-29");
    const updated = report();
    updated.feeds.points[0] = point("2025-12-29", 8, 4, 5);
    rerender(view(updated));
    expect(selector.value).toBe("2025-12-29");
    expect(within(screen.getByRole("region", { name: "Feeds per day: selected week" })).getByText("8.0")).toBeTruthy();

    const next = report();
    next.startKey = "2026-02-02";
    next.endKey = "2026-02-22";
    next.weeks = 3;
    for (const [key] of panels) {
      next[key] = { points: [point("2026-02-02", null, 0, 0), point("2026-02-09", allBlank ? null : 3, allBlank ? 0 : 5, 6), point("2026-02-16", null, 0, 1)], daysCounted: allBlank ? 0 : 5 };
    }
    rerender(view(next));
    const expectedWeek = allBlank ? "2026-02-16" : "2026-02-09";
    expect(selector.value).toBe(expectedWeek);
    const detail = screen.getByRole("region", { name: "Feeds per day: selected week" });
    expect(within(detail).getByText(allBlank ? "Feb 16, 2026 – Feb 22, 2026" : "Feb 9, 2026 – Feb 15, 2026")).toBeTruthy();
    expect(within(detail).getByText(allBlank ? "Not enough logged" : "3.0", { exact: true })).toBeTruthy();
    expect(detail.textContent).toContain(allBlank ? "0 days counted · 1 day logged" : "5 days counted · 6 days logged");
    expectLink(detail, "feeding", expectedWeek);
    expect(detail.textContent).not.toContain("Dec 29");
    for (const control of screen.getAllByRole("combobox") as HTMLSelectElement[]) expect(control.value).toBe(expectedWeek);

    rerender(view());
    expect(selector.value).toBe("2026-01-12");
    expectLink(screen.getByRole("region", { name: "Feeds per day: selected week" }), "feeding", "2026-01-12");
  });

  it("keeps all eight blank panels inspectable and defaults to the most recent unavailable week", async () => {
    const user = userEvent.setup();
    const blank = report();
    blank.anyData = false;
    for (const [key] of panels) {
      blank[key] = { points: [point("2026-01-12", null, 0, 2), point("2026-01-19", null, 0, 0)], daysCounted: 0 };
    }
    const { container } = render(view(blank));
    expect(screen.getAllByRole("combobox")).toHaveLength(8);
    for (const [, title, type] of panels) {
      const selector = screen.getByRole("combobox", { name: `${title}: week` }) as HTMLSelectElement;
      const detail = screen.getByRole("region", { name: `${title}: selected week` });
      expect(selector.value).toBe("2026-01-19");
      expect(within(detail).getByText("Not enough logged", { exact: true })).toBeTruthy();
      expectLink(detail, type, "2026-01-19");
      await user.selectOptions(selector, "2026-01-12");
      expect(within(detail).getByText("Jan 12, 2026 – Jan 18, 2026")).toBeTruthy();
      expect(detail.textContent).toContain("0 days counted · 2 days logged");
      expectLink(detail, type, "2026-01-12");
    }
    expect(container.querySelector("svg circle")).toBeNull();
    expect(container.textContent).not.toMatch(/Infinity|NaN|0 min highest|0.0 highest|→/);
  });

  it.each(panels)("selects %s weeks with accessible controls and updates only the selected detail", async (_key, title, type, recentValue, olderValue) => {
    const user = userEvent.setup();
    const { container } = render(view());
    const selectors = screen.getAllByRole("combobox");
    expect(selectors).toHaveLength(8);
    const selector = screen.getByRole("combobox", { name: `${title}: week` }) as HTMLSelectElement;
    expect(selector.tagName).toBe("SELECT");
    expect(selector.className).toContain("min-h-11");
    expect(selector.className).toContain("border-control");
    expect(selector.className).toContain("min-w-0");
    expect(selector.className).toContain("w-full");
    expect([...selector.options].map((option) => option.value)).toEqual(["2025-12-29", "2026-01-05", "2026-01-12", "2026-01-19"]);
    expect(selector.value).toBe("2026-01-12");

    const heading = screen.getByRole("heading", { name: title });
    const card = heading.parentElement!.parentElement!;
    const comparison = heading.parentElement!.querySelector("p")!.textContent;
    const detail = within(card).getByRole("region", { name: `${title}: selected week` });
    expect(detail.className).not.toContain("sr-only");
    expect(within(detail).getByText("Jan 12, 2026 – Jan 18, 2026")).toBeTruthy();
    expect(within(detail).getByText(recentValue, { exact: true })).toBeTruthy();
    expect(detail.textContent).toContain("6 days counted · 7 days logged");
    expect(detail.textContent).not.toContain("days unknown");
    expectLink(detail, type, "2026-01-12");
    expect(within(card).getAllByRole("link")).toHaveLength(1);

    // jsdom has no native arrow-key select implementation: tab proves keyboard reachability,
    // then userEvent.selectOptions dispatches the native selection/input/change sequence.
    for (let index = 0; index <= selectors.indexOf(selector); index++) {
      await user.tab();
      if (document.activeElement?.tagName === "A") await user.tab();
    }
    expect(document.activeElement).toBe(selector);
    await user.selectOptions(selector, "2025-12-29");
    expect(within(detail).getByText("Dec 29, 2025 – Jan 4, 2026")).toBeTruthy();
    expect(within(detail).getByText(olderValue, { exact: true })).toBeTruthy();
    expect(detail.textContent).toContain("3 days counted · 4 days logged · 1 day unknown");
    expectLink(detail, type, "2025-12-29");
    expect(heading.parentElement!.querySelector("p")!.textContent).toBe(comparison);

    await user.selectOptions(selector, "2026-01-05");
    expect(within(detail).getByText("Jan 5, 2026 – Jan 11, 2026")).toBeTruthy();
    expect(within(detail).getByText("Not enough logged", { exact: true })).toBeTruthy();
    expect(detail.textContent).toContain("0 days counted · 2 days logged · 2 days unknown");
    const reason = type === "sleep" ? "sleep that could not be allocated to this window"
      : type === "diaper" ? "a diaper with no recorded kind" : "a bottle with no usable amount";
    expect(detail.textContent).toContain(reason);
    expectLink(detail, type, "2026-01-05");
    expect(heading.parentElement!.querySelector("p")!.textContent).toBe(comparison);
    await user.selectOptions(selector, "2026-01-19");
    expect(detail.textContent).toContain("0 days counted · 0 days logged");
    expect(detail.textContent).not.toContain("unknown");
    expect(within(detail).queryByText(/unknown days had/i)).toBeNull();
    expect(detail.textContent).toContain("A weekly value is unavailable for the logged data.");
    expect(heading.parentElement!.querySelector("p")!.textContent).toBe(comparison);
    expectLink(detail, type, "2026-01-19");

    expect(container.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(8);
    expect(container.querySelectorAll("svg circle").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("svg [tabindex], svg [role=button], svg a, svg [onclick]")).toHaveLength(0);
    expect(container.querySelectorAll("ul.sr-only[data-trend-values]")).toHaveLength(8);
    const listed = card.querySelector("[data-trend-values]")!;
    expect(listed.textContent).toContain("Week of 2026-01-05: not enough logged");
    expect(listed.textContent).toContain(`Week of 2026-01-12: ${recentValue}`);
    await user.click(card.querySelector("svg circle")!);
    expect(selector.value).toBe("2026-01-19");
  });
});
