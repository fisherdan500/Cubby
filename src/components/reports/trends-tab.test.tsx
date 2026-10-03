// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TrendsTab } from "@/components/reports/trends-tab";
import type { Trends } from "@/server/services/trends";

function point(weekKey: string, value: number | null, daysCounted = 7, daysLogged = 7) {
  return { weekKey, value, daysCounted, daysLogged };
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
    feeds: empty,
    volume: empty,
    diapers: empty,
    ...overrides
  };
}

function render(view: Trends) {
  document.body.innerHTML = renderToStaticMarkup(<TrendsTab babyName="Avery" trends={view} periods={[]} />);
  return document.body;
}

describe("TrendsTab", () => {
  it("asks for a little more logging rather than drawing an empty chart", () => {
    const body = render(trends({ anyData: false }));

    expect(body.textContent).toContain("Not enough logged yet");
    expect(body.querySelector("svg")).toBeNull();
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
    expect(caption).not.toMatch(/because|transition|growth spurt|regression/i);
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

  it("draws nothing for a measure whose every week is blank", () => {
    const body = render(
      trends({ sleep: panel([point("2026-06-01", null, 0, 0), point("2026-06-08", null, 0, 0)]) })
    );

    expect([...body.querySelectorAll("h3")].map((node) => node.textContent)).not.toContain("Total sleep per day");
  });
});
