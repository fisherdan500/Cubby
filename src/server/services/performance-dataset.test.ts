import { describe, expect, it } from "vitest";
import { performanceDataset } from "../../../scripts/performance-dataset";
import { parseDatasetYears } from "../../../scripts/performance-budgets.acceptance-rehearsal";

const input = {
  householdId: "household-1",
  memberId: "member-1",
  babyIds: ["baby-1", "baby-2"] as const,
  endDate: new Date("2026-09-19T00:00:00.000Z")
};

describe("performance dataset", () => {
  it("is byte-identical between runs, so two measurements are comparable", () => {
    expect(JSON.stringify(performanceDataset({ ...input, years: 1 }))).toBe(
      JSON.stringify(performanceDataset({ ...input, years: 1 }))
    );
  });

  it("covers a year and five years of every day for every baby", () => {
    const oneYear = performanceDataset({ ...input, years: 1 });
    const fiveYears = performanceDataset({ ...input, years: 5 });

    expect(oneYear.counts.days).toBe(365);
    expect(oneYear.counts.activities).toBe(365 * 2 * 18);
    expect(fiveYears.counts.activities).toBe(5 * 365 * 2 * 18);
    expect(new Set(oneYear.activities.map((activity) => activity.babyId))).toEqual(new Set(input.babyIds));
    expect(new Set(oneYear.activities.map((activity) => activity.id)).size).toBe(oneYear.counts.activities);
    expect(Object.keys(oneYear.counts.perType).sort()).toEqual(["diaper", "feeding", "note", "sleep"]);
  });

  it("carries the realism the budget datasets require: typed details, timers, notes and corrections", () => {
    const dataset = performanceDataset({ ...input, years: 1 });

    expect(dataset.feedings.length + dataset.diapers.length + dataset.sleeps.length + dataset.notes.length).toBe(dataset.counts.activities);
    expect(dataset.counts.corrected).toBeGreaterThan(0);
    expect(dataset.activities.filter((activity) => activity.deletedAt).length).toBe(dataset.counts.corrected);
    expect(dataset.activities.filter((activity) => activity.durationSeconds).length).toBe(dataset.sleeps.length);
    expect(dataset.activities.filter((activity) => activity.notes).length).toBeGreaterThan(0);
  });

  it("ends on the requested day and never runs past it", () => {
    const dataset = performanceDataset({ ...input, years: 1 });
    const latest = dataset.activities.reduce((newest, activity) => (activity.occurredAt > newest ? activity.occurredAt : newest), new Date(0));

    expect(latest.toISOString().slice(0, 10)).toBe("2026-09-19");
    expect(latest.getTime()).toBeLessThan(input.endDate.getTime() + 86_400_000);
  });

  it("accepts only the two documented dataset sizes", () => {
    expect(parseDatasetYears([])).toBe(1);
    expect(parseDatasetYears(["--years=5"])).toBe(5);
    expect(() => parseDatasetYears(["--years=3"])).toThrow("performance_budgets_rehearsal_years_invalid");
  });
});
