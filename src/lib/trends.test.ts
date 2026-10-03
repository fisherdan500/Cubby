import { describe, expect, it } from "vitest";
import { ROUTINE_MIN_DAYS } from "@/lib/observed-routine";
import { bucketWeeks, completeDays, trendSeries, VOLUME_MIN_MEASURED_SHARE } from "@/lib/trends";

const timeZone = "America/New_York";

/** A day's worth of counted things, as the series builder takes them. */
function day(key: string, entries: number, value: number | null = entries) {
  return { key, entries, value };
}

describe("weekly buckets", () => {
  it("groups days into weeks starting Monday, in the household's zone", () => {
    const weeks = bucketWeeks(["2026-06-01", "2026-06-07", "2026-06-08"], timeZone);

    // 1 June 2026 is a Monday, 7 June the Sunday that closes that week.
    expect(weeks).toEqual([
      { weekKey: "2026-06-01", dayKeys: ["2026-06-01", "2026-06-07"] },
      { weekKey: "2026-06-08", dayKeys: ["2026-06-08"] }
    ]);
  });

  it("keeps a week that straddles a month or a year together", () => {
    const weeks = bucketWeeks(["2026-12-28", "2027-01-03"], timeZone);
    expect(weeks).toEqual([{ weekKey: "2026-12-28", dayKeys: ["2026-12-28", "2027-01-03"] }]);
  });
});

describe("the completeness floor", () => {
  // The User's case: a sitter has the baby and logs one feed, or nothing at all. A day with nothing
  // is already absent from the data. A day with ONE entry is the dangerous one -- it looks logged.
  it("drops a day far below the week's own median rather than averaging it in", () => {
    const days = [day("d1", 5), day("d2", 5), day("d3", 5), day("d4", 5), day("d5", 5), day("d6", 5), day("d7", 1)];

    const kept = completeDays(days);

    expect(kept.map((entry) => entry.key)).toEqual(["d1", "d2", "d3", "d4", "d5", "d6"]);
  });

  it("keeps every day when the week is evenly logged", () => {
    const days = [day("d1", 5), day("d2", 4), day("d3", 6), day("d4", 5)];
    expect(completeDays(days)).toHaveLength(4);
  });

  it("measures the floor against the week itself, not a fixed number of entries", () => {
    // Feeding legitimately halves as a baby grows: a fixed "at least 4 entries" would discard real
    // September days while passing junk March days. Four feeds is normal here and must survive.
    const sparseWeek = [day("d1", 4), day("d2", 4), day("d3", 4), day("d4", 4)];
    expect(completeDays(sparseWeek)).toHaveLength(4);

    const busyWeek = [day("d1", 14), day("d2", 14), day("d3", 14), day("d4", 4)];
    expect(completeDays(busyWeek).map((entry) => entry.key)).toEqual(["d1", "d2", "d3"]);
  });

  it("never drops every day, however lopsided the week", () => {
    // A floor that could empty a week would turn one odd day into a gap for the whole week.
    const kept = completeDays([day("d1", 20), day("d2", 1)]);
    expect(kept.length).toBeGreaterThan(0);
  });
});

describe("the weekly series", () => {
  it("averages over the days it kept, not the days in the week", () => {
    const week = [day("d1", 5), day("d2", 5), day("d3", 5), day("d4", 5), day("d5", 5), day("d6", 5), day("d7", 1)];

    const [point] = trendSeries([{ weekKey: "2026-06-01", days: week }]);

    // 30 over the 6 complete days, NOT 31/7 = 4.43: the sitter day must not invent an 11% dip.
    expect(point.value).toBeCloseTo(5, 5);
    expect(point.daysCounted).toBe(6);
    expect(point.daysLogged).toBe(7);
  });

  it("leaves a week blank when too few days survive the floor", () => {
    // Matches ROUTINE_MIN_DAYS so Trends and Routine agree on what is too little to speak from.
    const thin = Array.from({ length: ROUTINE_MIN_DAYS - 1 }, (_, index) => day(`d${index}`, 5));

    const [point] = trendSeries([{ weekKey: "2026-06-01", days: thin }]);

    expect(point.value).toBeNull();
    expect(point.daysCounted).toBe(ROUTINE_MIN_DAYS - 1);
  });

  it("reports a week with no logged days at all as blank, not as zero", () => {
    const [point] = trendSeries([{ weekKey: "2026-06-01", days: [] }]);
    expect(point.value).toBeNull();
    expect(point.daysCounted).toBe(0);
  });

  it("keeps weeks in order, including the blank ones, so the shape of a gap is visible", () => {
    const series = trendSeries([
      { weekKey: "2026-06-01", days: [day("a", 5), day("b", 5), day("c", 5)] },
      { weekKey: "2026-06-08", days: [day("d", 5)] },
      { weekKey: "2026-06-15", days: [day("e", 5), day("f", 5), day("g", 5)] }
    ]);

    expect(series.map((point) => point.weekKey)).toEqual(["2026-06-01", "2026-06-08", "2026-06-15"]);
    expect(series.map((point) => point.value !== null)).toEqual([true, false, true]);
  });

  it("carries a value of zero through as a real measurement", () => {
    // Zero diapers on a fully logged day is a fact, not missing data, and must not read as a gap.
    const week = [day("d1", 4, 0), day("d2", 4, 0), day("d3", 4, 0)];
    const [point] = trendSeries([{ weekKey: "2026-06-01", days: week }]);
    expect(point.value).toBe(0);
  });
});

describe("the volume series", () => {
  // Breastfeeds carry no volume -- they cannot. Summing a month that was mostly breastfeeding would
  // show a near-zero intake, then a cliff when the household switched to bottles, implying the baby
  // suddenly ate three times as much. The share of feeds actually measured is the guard.
  it("stays blank for a week where most feeds carry no volume", () => {
    const [point] = trendSeries(
      [{ weekKey: "2026-03-16", days: [day("d1", 14, 1), day("d2", 14, 1), day("d3", 14, 0)] }],
      { measuredShare: [0.07, 0.07, 0] }
    );

    expect(point.value).toBeNull();
  });

  it("reports a week where every feed was measured", () => {
    const [point] = trendSeries(
      [{ weekKey: "2026-06-01", days: [day("d1", 5, 22), day("d2", 5, 24), day("d3", 5, 20)] }],
      { measuredShare: [1, 1, 1] }
    );

    expect(point.value).toBeCloseTo(22, 5);
  });

  it("requires nearly every feed to be measured before it will speak", () => {
    expect(VOLUME_MIN_MEASURED_SHARE).toBeGreaterThanOrEqual(0.9);

    const [borderline] = trendSeries(
      [{ weekKey: "2026-05-18", days: [day("d1", 7, 18), day("d2", 7, 18), day("d3", 7, 18)] }],
      { measuredShare: [0.78, 0.78, 0.78] }
    );

    expect(borderline.value).toBeNull();
  });
});
