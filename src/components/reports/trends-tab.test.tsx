// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { TrendsTab } from "@/components/reports/trends-tab";
import type { Trends } from "@/server/services/trends";

afterEach(() => { cleanup(); document.body.replaceChildren(); });

function point(weekKey: string, value: number | null, daysCounted = 7, daysLogged = 7, daysUnknown = 0) {
  return { weekKey, value, daysCounted, daysLogged, daysUnknown };
}

function panel(points: ReturnType<typeof point>[]) {
  return { points, daysCounted: points.reduce((total, item) => total + item.daysCounted, 0) };
}

function trends(overrides: Partial<Trends> = {}): Trends {
  const empty = panel([]);
  return {
    startKey: "2026-06-01",
    endKey: "2026-06-21",
    weeks: 3,
    anyData: true,
    sleep: empty,
    daytimeSleep: empty,
    nighttimeSleep: empty,
    feeds: empty,
    volume: empty,
    diapers: empty,
    wetDiapers: empty,
    dirtyDiapers: empty,
    ...overrides
  };
}

function render(view: Trends, babyId = "baby-1") {
  cleanup();
  document.body.innerHTML = renderToStaticMarkup(<TrendsTab babyId={babyId} babyName="Avery" trends={view} periods={[]} />);
  return document.body;
}

describe("TrendsTab", () => {
  it.each(["daytimeSleep", "nighttimeSleep"] as const)("explains unknown %s days as unavailable sleep allocation", (key) => {
    const body = render(trends({ [key]: panel([point("2026-06-01", 5400, 3, 4, 1)]) }));

    expect(body.textContent).toContain("3 of 4 days · 1 day had sleep that could not be allocated to this window");
    expect(body.textContent).not.toMatch(/bottle|diaper/);
  });

  it.each(["daytimeSleep", "nighttimeSleep"] as const)("links %s to sleep records preserving baby and recent nonblank week", (key) => {
    const babyId = "baby /?&=Avery";
    const body = render(trends({ [key]: panel([
      point("2025-12-29", 5400), point("2026-01-05", null, 0, 0), point("2026-01-12", 0), point("2026-01-19", null, 0, 0)
    ]) }), babyId);
    const link = body.querySelector<HTMLAnchorElement>('a[href^="/app/history?"]');

    expect(link).not.toBeNull();
    const url = new URL(link!.getAttribute("href")!, "https://cubby.example.test");
    expect([...url.searchParams.entries()]).toEqual([["babyId", babyId], ["type", "sleep"], ["week", "2026-01-12"]]);
    expect(link?.textContent).toBe("View sleep records in this week");
    expect(link?.parentElement?.textContent).toContain("Jan 12, 2026 – Jan 18, 2026");
    expect(body.textContent).not.toMatch(/records counted|contributing records|last week|previous week/i);
  });

  it.each(["daytimeSleep", "nighttimeSleep"] as const)("compares %s as neutral longer/shorter durations with the duration tolerance", (key) => {
    for (const [recent, expected] of [
      [9000, "1h longer"], [1800, "1h shorter"], [5459, "No change"], [5460, "1 min longer"]
    ] as const) {
      const body = render(trends({ [key]: panel([point("2026-06-01", 5400), point("2026-06-08", recent)]) }));

      expect(body.querySelector("h3")?.parentElement?.textContent).toContain(`${expected} per logged day.`);
      expect(body.textContent).not.toMatch(/more|fewer|ounces|because|caused|due to|transition|growth spurt|regression|healthy|normal|adequate|diagnos|developmental|should|recommend|better|worse/i);
    }
  });

  it.each([
    ["daytimeSleep", "Daytime sleep per day (7 AM–7 PM)"],
    ["nighttimeSleep", "Nighttime sleep per day (7 PM–7 AM)"]
  ] as const)("labels %s with its exact clock window and formats durations", (key, title) => {
    const body = render(trends({ [key]: panel([point("2026-06-01", 5400), point("2026-06-08", 0)]) }));

    expect(body.querySelector("h3")?.textContent).toBe(title);
    expect(body.querySelector("[data-trend-values]")?.textContent).toBe("Week of 2026-06-01: 1h 30mWeek of 2026-06-08: 0 min");
    expect(body.textContent).toContain("1h 30m highest · 14 of 14 days");
  });

  it.each([
    ["wetDiapers", "Wet diapers per day"], ["dirtyDiapers", "Dirty diapers per day"]
  ] as const)("shows %s as counts, including a known zero", (key, title) => {
    const body = render(trends({ [key]: panel([point("2026-06-01", 2.25), point("2026-06-08", 0)]) }));

    expect(body.querySelector("h3")?.textContent).toBe(title);
    expect(body.querySelector("[data-trend-values]")?.textContent).toBe("Week of 2026-06-01: 2.3Week of 2026-06-08: 0.0");
    expect(body.textContent).toContain("2.3 highest · 14 of 14 days");
    expect(body.querySelectorAll("svg circle")).toHaveLength(2);

    const blank = render(trends({ [key]: panel([point("2026-06-01", null, 0, 0)]) }));
    expect(blank.querySelector("h3")?.textContent).toBe(title);
    expect(blank.querySelector("svg circle")).toBeNull();
  });

  it.each(["wetDiapers", "dirtyDiapers"] as const)("compares %s with neutral more/fewer count arithmetic", (key) => {
    for (const [recent, expected] of [[3.5, "1.0 more"], [1.5, "1.0 fewer"], [2.5, "No change"]] as const) {
      const body = render(trends({ [key]: panel([point("2026-06-01", 2.5), point("2026-06-08", recent)]) }));
      expect(body.querySelector("h3")?.parentElement?.textContent).toContain(`${expected} per logged day.`);
      expect(body.textContent).not.toMatch(/longer|shorter|ounces|because|caused|due to|transition|growth spurt|regression|healthy|normal|adequate|diagnos|developmental|should|recommend|better|worse/i);
    }
  });

  it.each(["wetDiapers", "dirtyDiapers"] as const)("links %s to diaper records preserving the selected baby and recent nonblank week", (key) => {
    const babyId = "baby /?&=Avery";
    const body = render(trends({ [key]: panel([
      point("2025-12-29", 3), point("2026-01-05", null, 0, 0), point("2026-01-12", 0), point("2026-01-19", null, 0, 0)
    ]) }), babyId);
    const link = body.querySelector<HTMLAnchorElement>('a[href^="/app/history?"]');

    expect(link).not.toBeNull();
    const url = new URL(link!.getAttribute("href")!, "https://cubby.example.test");
    expect([...url.searchParams.entries()]).toEqual([["babyId", babyId], ["type", "diaper"], ["week", "2026-01-12"]]);
    expect(link?.textContent).toBe("View diaper records in this week");
    expect(body.textContent).toContain("Dec 29, 2025 – Jan 4, 2026");
    expect(link?.parentElement?.textContent).toContain("Jan 12, 2026 – Jan 18, 2026");
    expect(body.textContent).not.toMatch(/records counted|contributing records|last week|previous week/i);
  });

  it.each(["wetDiapers", "dirtyDiapers"] as const)("explains unknown %s days without attributing them to bottle amounts", (key) => {
    const body = render(trends({ [key]: panel([point("2026-06-01", 2, 3, 4, 1)]) }));

    expect(body.textContent).toContain("3 of 4 days · 1 day had a diaper with no recorded kind");
    expect(body.textContent).not.toContain("bottle");
  });

  it("compares the two most recent nonblank points instead of the whole window", () => {
    const body = render(trends({ feeds: panel([
      point("2026-06-01", 9), point("2026-06-08", 6), point("2026-06-15", 4), point("2026-06-22", null, 0, 0)
    ]) }));

    const comparison = body.querySelector("h3")?.parentElement?.querySelector("p")?.textContent;
    expect(comparison).toContain("6.0");
    expect(comparison).toContain("4.0");
    expect(comparison).not.toContain("9.0");
  });

  it("asks for a little more logging rather than drawing an empty chart", () => {
    const body = render(trends({ anyData: false }));

    expect(body.textContent).toContain("Not enough logged yet");
    expect(body.querySelector("svg")).toBeNull();
  });

  it("names both exact week ranges across a blank gap and year boundary", () => {
    const body = render(trends({ feeds: panel([
      point("2025-12-29", 6), point("2026-01-05", null, 0, 0), point("2026-01-12", 4)
    ]) }));

    const comparison = body.querySelector("h3")?.parentElement?.querySelector("p")?.textContent;
    expect(comparison).toContain("Dec 29, 2025 – Jan 4, 2026");
    expect(comparison).toContain("Jan 12, 2026 – Jan 18, 2026");
    expect(body.textContent).not.toMatch(/last week|previous week/i);
  });

  it("describes count changes as more or fewer per logged day", () => {
    for (const key of ["feeds", "diapers"] as const) {
      for (const [recent, expected] of [[4, "2.0 fewer per logged day"], [8, "2.0 more per logged day"]] as const) {
        const body = render(trends({ [key]: panel([point("2026-06-01", 9), point("2026-06-08", 6), point("2026-06-15", recent)]) }));
        expect(body.querySelector("h3")?.parentElement?.textContent).toContain(expected);
      }
    }
  });

  it("describes sleep changes as a duration longer or shorter per logged day", () => {
    for (const [recent, expected] of [[13 * 3600, "1h shorter per logged day"], [15.5 * 3600, "1h 30m longer per logged day"]] as const) {
      const body = render(trends({ sleep: panel([point("2026-06-01", 14 * 3600), point("2026-06-08", recent)]) }));
      expect(body.querySelector("h3")?.parentElement?.textContent).toContain(expected);
    }
  });

  it("describes volume changes as more or fewer ounces per logged day", () => {
    for (const [recent, expected] of [[22, "2.0 fewer ounces per logged day"], [26, "2.0 more ounces per logged day"]] as const) {
      const body = render(trends({ volume: panel([point("2026-06-01", 24), point("2026-06-08", recent)]) }));
      expect(body.querySelector("h3")?.parentElement?.textContent).toContain(expected);
    }
  });

  it("uses strict equality tolerances of 60 seconds and 0.05 counts or ounces", () => {
    for (const key of ["sleep", "feeds", "diapers", "volume"] as const) {
      const threshold = key === "sleep" ? 60 : 0.05;
      for (const difference of [0, threshold * 0.99, threshold]) {
        for (const [earlier, recent] of [[0, difference], [difference, 0]]) {
          const body = render(trends({ [key]: panel([point("2026-06-01", earlier), point("2026-06-08", recent)]) }));
          const comparison = body.querySelector("h3")?.parentElement?.querySelector("p")?.textContent;
          if (difference < threshold) {
            expect(comparison).toContain("No change per logged day.");
            expect(comparison).not.toMatch(/more|fewer|longer|shorter/);
          } else {
            const direction = key === "sleep" ? (recent > earlier ? "longer" : "shorter") : (recent > earlier ? "more" : "fewer");
            const expected = key === "sleep" ? `1 min ${direction}` : `0.1 ${direction}${key === "volume" ? " ounces" : ""}`;
            expect(comparison).toContain(`${expected} per logged day.`);
            expect(comparison).not.toContain("No change");
          }
        }
      }
    }
  });

  it("shows no comparison with fewer than two nonblank points", () => {
    for (const key of ["sleep", "feeds", "diapers", "volume"] as const) {
      for (const points of [[], [point("2026-06-01", null, 0, 0)], [point("2026-06-01", null, 0, 0), point("2026-06-08", 0), point("2026-06-15", null, 0, 0)]]) {
        const body = render(trends({ [key]: panel(points) }));
        expect(body.querySelector("h3")?.parentElement?.querySelector("p")).toBeFalsy();
        expect(body.textContent).not.toMatch(/per logged day|compared|→/);
      }
    }
  });

  it("links the recent measured week to records of the right type in that week", () => {
    const babyId = "baby /?&=Avery";
    for (const [key, type] of [["sleep", "sleep"], ["feeds", "feeding"], ["volume", "feeding"], ["diapers", "diaper"]] as const) {
      for (const earlier of [null, 4]) {
        const body = render(trends({ [key]: panel([
          point("2025-12-29", earlier), point("2026-01-05", null, 0, 0), point("2026-01-12", 0), point("2026-01-19", null, 0, 0)
        ]) }), babyId);
        const link = body.querySelector<HTMLAnchorElement>('a[href^="/app/history?"]');
        expect(link).not.toBeNull();
        const url = new URL(link!.getAttribute("href")!, "https://cubby.example.test");
        expect(url.pathname).toBe("/app/history");
        expect([...url.searchParams.entries()]).toEqual([["babyId", babyId], ["type", type], ["week", "2026-01-12"]]);
        expect(link?.textContent).toBe(`View ${type} records in this week`);
        expect(link?.parentElement?.textContent).toContain("Jan 12, 2026 – Jan 18, 2026");
        expect(body.textContent).not.toMatch(/records counted|contributing records/i);
      }
    }
  });

  it("draws a panel for each measure that has something to say", () => {
    const body = render(
      trends({
        feeds: panel([point("2026-06-01", 5), point("2026-06-08", 4.5), point("2026-06-15", 4)]),
        diapers: panel([point("2026-06-01", 6), point("2026-06-08", 5), point("2026-06-15", 5)])
      })
    );

    const headings = [...body.querySelectorAll("h3")].map((node) => node.textContent);
    expect(headings).toContain("Feeds per day");
    expect(headings).toContain("Diapers per day");
    // Sleep and volume have no points, so they are left out rather than drawn flat at zero.
    expect(headings).not.toContain("Total sleep per day");
    expect(headings).not.toContain("Bottle and formula per day");
  });

  it("breaks the line at a blank week instead of drawing straight across it", () => {
    const body = render(
      trends({
        feeds: panel([point("2026-06-01", 5), point("2026-06-08", null, 0, 0), point("2026-06-15", 4)])
      })
    );

    // Two separate paths, not one: a single path would imply a steady slope through the gap, which
    // is exactly the week nobody logged.
    const paths = body.querySelectorAll("svg path[data-trend-line]");
    expect(paths).toHaveLength(2);
  });

  it("says how many days each figure rests on", () => {
    const body = render(trends({ feeds: panel([point("2026-06-01", 5, 6, 7), point("2026-06-08", 5, 7, 7), point("2026-06-15", 5, 7, 7)]) }));

    // 20 of 21: the household can see that a day was set aside rather than silently averaged in.
    expect(body.textContent).toContain("20 of 21 days");
  });

  it("states the change in plain arithmetic, naming no cause", () => {
    const body = render(
      trends({ feeds: panel([point("2026-06-01", 8), point("2026-06-08", 6), point("2026-06-15", 4)]) })
    );

    const caption = body.textContent ?? "";
    expect(caption).toContain("8.0");
    expect(caption).toContain("4.0");
    // It reports the numbers; it does not diagnose. Those words would be a claim Cubby cannot support.
    expect(caption).not.toMatch(/because|caused|due to|transition|growth spurt|regression|healthy|normal|adequate|diagnos|developmental|should|recommend|better|worse/i);
  });

  it("formats sleep as hours and minutes, not as a bare number of seconds", () => {
    const body = render(
      trends({
        sleep: panel([point("2026-06-01", 14 * 3600), point("2026-06-08", 13.5 * 3600), point("2026-06-15", 13 * 3600)])
      })
    );

    expect(body.textContent).toMatch(/14h/);
    expect(body.textContent).not.toContain("50400");
  });

  it("explains that volume covers only the feeds that were measured", () => {
    const body = render(
      trends({ volume: panel([point("2026-06-01", 22), point("2026-06-08", 24), point("2026-06-15", 26)]) })
    );

    // Breastfeeds carry no volume, so this panel is about bottles and formula only and must say so.
    expect(body.textContent).toMatch(/bottle and formula/i);
  });

  it("lists the weekly figures as text, so the chart is not the only way to read them", () => {
    // Review: the repo's existing Growth charts are aria-hidden BECAUSE every point is also listed
    // as text. role="img" with a bare label asserts the alt text is enough, and for a 29-week series
    // it is not. Follow the convention already here rather than inventing a weaker one.
    const body = render(
      trends({ feeds: panel([point("2026-06-01", 5), point("2026-06-08", 4), point("2026-06-15", 3)]) })
    );

    expect(body.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const listed = body.querySelector("[data-trend-values]");
    expect(listed).toBeTruthy();
    expect(listed?.textContent).toContain("5.0");
    expect(listed?.textContent).toContain("3.0");
  });

  it("centres a lone week rather than pinning it to the left edge", () => {
    // Matches GrowthChart, which already centres a single measurement.
    const body = render(trends({ feeds: panel([point("2026-06-01", 5)]) }));

    const dot = body.querySelector("svg circle");
    expect(dot).toBeTruthy();
    expect(Number(dot?.getAttribute("cx"))).toBeGreaterThan(100);
  });

  it("keeps detail available without drawing values for a measure whose every week is blank", () => {
    const body = render(
      trends({ sleep: panel([point("2026-06-01", null, 0, 0), point("2026-06-08", null, 0, 0)]) })
    );

    expect([...body.querySelectorAll("h3")].map((node) => node.textContent)).toContain("Total sleep per day");
    expect(body.querySelector("svg circle")).toBeNull();
    expect(body.querySelector("section")?.textContent).toContain("Not enough logged");
  });
  it("says how many days had a bottle with no amount, rather than implying full coverage", () => {
    // "4 of 4 days" on a week logged across seven reads as complete. The days set aside have to be
    // visible, or the household trusts a figure built on less than it logged.
    const body = render(
      trends({
        volume: panel([point("2026-06-01", 16, 4, 4, 3), point("2026-06-08", 18, 5, 5, 2)])
      })
    );

    expect(body.textContent).toContain("5 days had a bottle with no usable amount");
  });

  it("says nothing about set-aside days when every bottle was written down", () => {
    const body = render(trends({ volume: panel([point("2026-06-01", 16, 7, 7, 0)]) }));

    expect(body.textContent).not.toContain("had a bottle with no usable amount");
  });
});
