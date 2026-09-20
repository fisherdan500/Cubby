import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultUnitPreferences } from "@/domain/unit-preferences";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  getHouseholdHome: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({ prisma: { activityLog: { findMany: mocks.findMany } } }));
vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));
vi.mock("@/server/services/households", () => ({ getHouseholdHome: mocks.getHouseholdHome }));

import { buildReportStats, getReports } from "@/server/services/reports";

const zone = "America/New_York";

type Detail = Record<string, unknown>;

function activity(type: string, occurredAt: string, detail: Detail = {}) {
  return { type, occurredAt: new Date(occurredAt), durationSeconds: null, ...detail } as never;
}

function stats(activities: unknown[], birthDate: Date | null = null) {
  return buildReportStats(activities as never, birthDate, zone, defaultUnitPreferences);
}

function heatmapCell(result: ReturnType<typeof stats>, day: number, hour: number) {
  return result.heatmap[day * 24 + hour].count;
}

describe("report statistics buckets", () => {
  it("places an activity on the household's day and hour, not UTC's", () => {
    // 01:30Z on Monday is still 9:30 pm Sunday in New York.
    const result = stats([activity("diaper", "2026-09-21T01:30:00.000Z", { diaper: { kind: "wet" } })]);

    expect(heatmapCell(result, 0, 21)).toBe(1);
    expect(heatmapCell(result, 1, 1)).toBe(0);
  });

  it("keeps local hours correct across both daylight-saving transitions", () => {
    // 2026-03-08 the clocks jump 2am EST to 3am EDT; 2026-11-01 1am-2am happens twice.
    const spring = stats([activity("note", "2026-03-08T07:30:00.000Z", { note: { text: "after the jump" } })]);
    const autumnFirst = stats([activity("note", "2026-11-01T05:30:00.000Z", { note: { text: "first 1:30" } })]);
    const autumnSecond = stats([activity("note", "2026-11-01T06:30:00.000Z", { note: { text: "second 1:30" } })]);

    expect(heatmapCell(spring, 0, 3)).toBe(1);
    expect(heatmapCell(autumnFirst, 0, 1)).toBe(1);
    expect(heatmapCell(autumnSecond, 0, 1)).toBe(1);
  });

  it("counts every activity once under its own type", () => {
    const result = stats([
      activity("feeding", "2026-09-19T14:00:00.000Z", { feeding: { mode: "bottle", amount: 4, unit: "oz" } }),
      activity("feeding", "2026-09-19T17:00:00.000Z", { feeding: { mode: "breast" } }),
      activity("sleep", "2026-09-19T18:00:00.000Z", { durationSeconds: 3600, sleep: { sleepType: "nap" } })
    ]);

    expect(result.byType.feeding).toBe(2);
    expect(result.byType.sleep).toBe(1);
    expect(result.byType.diaper).toBe(0);
  });
});

describe("sleep statistics", () => {
  it("totals sleep, averages it over sleep logs only, and separates naps from night sleep", () => {
    const result = stats([
      activity("sleep", "2026-09-19T14:00:00.000Z", { durationSeconds: 3_600, sleep: { sleepType: "nap" } }),
      activity("sleep", "2026-09-19T18:00:00.000Z", { durationSeconds: 1_800, sleep: { sleepType: "nap" } }),
      activity("sleep", "2026-09-20T02:00:00.000Z", { durationSeconds: 27_000, sleep: { sleepType: "night" } }),
      activity("diaper", "2026-09-19T15:00:00.000Z", { diaper: { kind: "wet" } })
    ]);

    expect(result.sleep.total).toBe("9h");
    // 32,400 seconds over the three sleep logs (3h), not over all four activities (which would be 2h 15m).
    expect(result.sleep.average).toBe("3h");
    expect(result.sleep.naps).toBe(2);
    expect(result.sleep.night).toBe("7h 30m");
  });

  it("reports zero sleep as a duration rather than an empty string", () => {
    const result = stats([activity("diaper", "2026-09-19T15:00:00.000Z", { diaper: { kind: "wet" } })]);

    expect(result.sleep).toMatchObject({ total: "0 min", average: "0 min", night: "0 min", naps: 0 });
  });
});

describe("feeding and diaper statistics", () => {
  it("averages bottle volume over bottle feeds after converting units", () => {
    const result = stats([
      activity("feeding", "2026-09-19T14:00:00.000Z", { feeding: { mode: "bottle", amount: 4, unit: "oz" } }),
      activity("feeding", "2026-09-19T17:00:00.000Z", { feeding: { mode: "formula", amount: 177.44, unit: "mL" } }),
      activity("feeding", "2026-09-19T19:00:00.000Z", { feeding: { mode: "breast" } }),
      activity("feeding", "2026-09-19T21:00:00.000Z", { feeding: { mode: "solids" } })
    ]);

    // 4 oz and 177.44 mL (6 oz) over the two bottle-style feeds.
    expect(result.feeding).toMatchObject({ bottleCount: 2, bottleAverage: 5, unit: "oz", breastCount: 1, solidsCount: 1 });
  });

  it("refuses to average a bottle volume it cannot convert, instead of guessing", () => {
    const result = stats([
      activity("feeding", "2026-09-19T14:00:00.000Z", { feeding: { mode: "bottle", amount: 4, unit: "oz" } }),
      activity("feeding", "2026-09-19T17:00:00.000Z", { feeding: { mode: "bottle", amount: 100, unit: "cups" } })
    ]);

    expect(result.feeding.bottleCount).toBe(2);
    expect(result.feeding.bottleAverage).toBeNull();
  });

  it("counts a mixed diaper as both wet and dirty, and a dry one as neither", () => {
    const result = stats([
      activity("diaper", "2026-09-19T14:00:00.000Z", { diaper: { kind: "wet" } }),
      activity("diaper", "2026-09-19T15:00:00.000Z", { diaper: { kind: "dirty" } }),
      activity("diaper", "2026-09-19T16:00:00.000Z", { diaper: { kind: "mixed" } }),
      activity("diaper", "2026-09-19T17:00:00.000Z", { diaper: { kind: "dry" } })
    ]);

    expect(result.diaper).toEqual({ wet: 2, dirty: 2 });
  });

  it("totals pumped volume, and reports it unavailable when a unit is unsupported", () => {
    const converted = stats([
      activity("pumping", "2026-09-19T14:00:00.000Z", { pumping: { amount: 3, unit: "oz" } }),
      activity("pumping", "2026-09-19T18:00:00.000Z", { pumping: { amount: 88.72, unit: "mL" } })
    ]);
    const unsupported = stats([activity("pumping", "2026-09-19T14:00:00.000Z", { pumping: { amount: 3, unit: "pints" } })]);

    expect(converted.pumping).toEqual({ total: 6, unit: "oz" });
    expect(unsupported.pumping.total).toBeNull();
  });
});

describe("growth and milestones", () => {
  it("records each measurement on its household day with the baby's age in months", () => {
    const birthDate = new Date("2026-03-19T00:00:00.000Z");
    const result = stats(
      [activity("measurement", "2026-09-20T01:30:00.000Z", { measurement: { weight: 14.2, weightUnit: "lb" } })],
      birthDate
    );

    // 01:30Z is still the 19th in New York; 185 days is 6.1 average months after the birth date.
    expect(result.growth.weight).toEqual([{ date: "2026-09-19", ageMonths: 6.1, value: 14.2, unit: "lb" }]);
    expect(result.growth.length).toEqual([]);
  });

  it("keeps milestones with their moment, title and category", () => {
    const result = stats([
      activity("milestone", "2026-09-19T14:00:00.000Z", { milestone: { title: "First steps", category: "Motor" } })
    ]);

    expect(result.milestones).toEqual([
      { date: new Date("2026-09-19T14:00:00.000Z"), title: "First steps", category: "Motor" }
    ]);
  });
});

describe("report range", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getEffectiveHouseholdContext.mockResolvedValue({ householdId: "household-1", memberId: "member-1", role: "owner" });
    mocks.getHouseholdHome.mockResolvedValue({
      household: { babies: [{ id: "baby-1", birthDate: null }], settings: null }
    });
    mocks.findMany.mockResolvedValue([]);
  });

  it("covers whole household days from the start through the end, and skips corrected entries", async () => {
    await getReports("user-1", { babyId: "baby-1", start: "2026-09-13", end: "2026-09-19" });
    const where = mocks.findMany.mock.calls[0]?.[0].where;

    // Midnight to midnight in the household zone (EDT, UTC-4), end day included.
    expect(where.occurredAt.gte).toEqual(new Date("2026-09-13T04:00:00.000Z"));
    expect(where.occurredAt.lt).toEqual(new Date("2026-09-20T04:00:00.000Z"));
    expect(where.deletedAt).toBeNull();
    expect(where.babyId).toBe("baby-1");
    expect(where.householdId).toBe("household-1");
  });

  it("still covers whole days when the range ends on the day the clocks change", async () => {
    await getReports("user-1", { babyId: "baby-1", start: "2026-11-01", end: "2026-11-01" });
    const where = mocks.findMany.mock.calls[0]?.[0].where;

    // 1 November starts at 04:00Z (EDT) and the next day starts at 05:00Z (EST): a 25-hour day.
    expect(where.occurredAt.gte).toEqual(new Date("2026-11-01T04:00:00.000Z"));
    expect(where.occurredAt.lt).toEqual(new Date("2026-11-02T05:00:00.000Z"));
  });

  it("falls back to the last seven days when the range is missing or malformed", async () => {
    vi.setSystemTime(new Date("2026-09-19T15:00:00.000Z"));
    const report = await getReports("user-1", { babyId: "baby-1", start: "not-a-date", end: "2026-13-45" });

    expect(report?.startKey).toBe("2026-09-13");
    expect(report?.endKey).toBe("2026-09-19");
    vi.useRealTimers();
  });
});
