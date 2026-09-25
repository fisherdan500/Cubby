import { describe, expect, it } from "vitest";
import { formatAge, growthSeries, milestoneTimeline } from "@/lib/growth-history";

const point = (date: string, value: number, ageMonths: number | null = null, unit = "kg") => ({ date, value, unit, ageMonths });

describe("growthSeries", () => {
  it("leads with the latest measurement and how it changed since the one before", () => {
    const series = growthSeries([point("2026-07-10", 7.4, 4), point("2026-08-12", 7.9, 5), point("2026-09-15", 8.2, 6.1)]);

    expect(series?.latest).toEqual({ value: "8.2 kg", date: "Sep 15, 2026", age: "6 months" });
    expect(series?.sinceLast).toEqual({ change: "+0.3 kg", since: "Aug 12" });
  });

  it("lists the history newest first, each with its own change", () => {
    const series = growthSeries([point("2026-07-10", 7.4), point("2026-08-12", 7.9), point("2026-09-15", 7.9)]);

    expect(series?.entries.map(({ date, value, change }) => [date, value, change])).toEqual([
      ["Sep 15, 2026", "7.9 kg", "Same"],
      ["Aug 12, 2026", "7.9 kg", "+0.5 kg"],
      ["Jul 10, 2026", "7.4 kg", null]
    ]);
  });

  it("orders by date even when measurements were logged out of order", () => {
    const series = growthSeries([point("2026-09-15", 8.2), point("2026-07-10", 7.4)]);
    expect(series?.latest?.date).toBe("Sep 15, 2026");
    expect(series?.sinceLast?.change).toBe("+0.8 kg");
  });

  it("says nothing it cannot back up", () => {
    expect(growthSeries(null)).toBeNull();
    expect(growthSeries([])).toEqual({ latest: null, sinceLast: null, entries: [] });
    expect(growthSeries([point("2026-09-15", 8.2)])?.sinceLast).toBeNull();
  });
});

describe("formatAge", () => {
  it("reads an age the way a parent would say it", () => {
    expect(formatAge(0.5)).toBe("2 weeks");
    expect(formatAge(1)).toBe("1 month");
    expect(formatAge(6.1)).toBe("6 months");
    expect(formatAge(12)).toBe("1 year");
    expect(formatAge(14.3)).toBe("1 year 2 months");
    expect(formatAge(null)).toBeNull();
  });
});

describe("milestoneTimeline", () => {
  it("groups milestones by month, newest first, with the baby's age at each", () => {
    const groups = milestoneTimeline([
      { date: new Date("2026-08-02T15:00:00Z"), title: "First smile", category: "Social", ageMonths: 4.5 },
      { date: new Date("2026-09-19T14:00:00Z"), title: "Rolled over", category: "Motor", ageMonths: 6 },
      { date: new Date("2026-09-03T14:00:00Z"), title: "Laughed", category: null, ageMonths: 5.5 }
    ], "America/New_York");

    expect(groups).toEqual([
      { month: "September 2026", items: [
        { title: "Rolled over", category: "Motor", date: "Sep 19", age: "6 months" },
        { title: "Laughed", category: null, date: "Sep 3", age: "5 months" }
      ] },
      { month: "August 2026", items: [{ title: "First smile", category: "Social", date: "Aug 2", age: "4 months" }] }
    ]);
  });

  it("files a late-evening milestone under the household's day and month, not UTC's", () => {
    // 01:30Z on 1 October is still 30 September in New York.
    const [group] = milestoneTimeline([{ date: new Date("2026-10-01T01:30:00Z"), title: "Sat up", category: null, ageMonths: null }], "America/New_York");
    expect(group).toEqual({ month: "September 2026", items: [{ title: "Sat up", category: null, date: "Sep 30", age: null }] });
  });
});
