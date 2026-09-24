import { ActivityType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { defaultUnitPreferences } from "@/domain/unit-preferences";
import { addDaysToDateKey, zonedDateTimeToDate } from "@/lib/timezone";
import { buildReportStats, buildRoutine, routineEventsFrom, routineWindowRange } from "@/server/services/reports";

const timeZone = "America/New_York";

describe("report volume statistics", () => {
  it("normalizes mixed feeding and pumping units into the household preference", () => {
    const stats = buildReportStats([
      statsActivity(ActivityType.feeding, { feeding: { mode: "bottle", amount: "1", unit: "oz" } }),
      statsActivity(ActivityType.feeding, { feeding: { mode: "formula", amount: "29.5735", unit: "mL" } }),
      statsActivity(ActivityType.pumping, { pumping: { amount: "2", unit: "oz" } }),
      statsActivity(ActivityType.pumping, { pumping: { amount: "59.147", unit: "mL" } })
    ], null, timeZone, { ...defaultUnitPreferences, volume: "mL" });

    expect(stats.feeding).toMatchObject({ bottleCount: 2, bottleAverage: 29.57, unit: "mL" });
    expect(stats.pumping).toEqual({ total: 118.29, unit: "mL" });
  });
});

describe("report sleep statistics", () => {
  const hour = 60 * 60;

  it("excludes a running sleep from the completed-sleep average without changing sibling counts", () => {
    const stats = buildReportStats([
      sleepLog("stopped", hour, "night"),
      sleepLog("running", null, "nap")
    ], null, timeZone, defaultUnitPreferences);

    expect(stats.byType.sleep).toBe(2);
    expect(stats.sleep).toEqual({ total: "1h", average: "1h", naps: 1, night: "1h" });
  });

  it("excludes a paused sleep from the completed-sleep average", () => {
    const stats = buildReportStats([
      sleepLog("stopped", 2 * hour),
      sleepLog("paused", null)
    ], null, timeZone, defaultUnitPreferences);

    expect(stats.sleep).toMatchObject({ total: "2h", average: "2h" });
  });

  it("excludes a manual sleep with no recorded duration, which is not a running timer", () => {
    const stats = buildReportStats([
      sleepLog("none", hour),
      sleepLog("none", 3 * hour),
      sleepLog("none", null)
    ], null, timeZone, defaultUnitPreferences);

    expect(stats.byType.sleep).toBe(3);
    expect(stats.sleep).toMatchObject({ total: "4h", average: "2h" });
  });

  it("averages several completed sleeps alongside an incomplete one", () => {
    const stats = buildReportStats([
      sleepLog("stopped", hour),
      sleepLog("none", 3 * hour),
      sleepLog("stopped", 2 * hour),
      sleepLog("running", null)
    ], null, timeZone, defaultUnitPreferences);

    expect(stats.sleep).toMatchObject({ total: "6h", average: "2h" });
  });

  it("counts a completed zero-length sleep as a completed log", () => {
    const stats = buildReportStats([
      sleepLog("stopped", 0),
      sleepLog("stopped", 2 * hour)
    ], null, timeZone, defaultUnitPreferences);

    expect(stats.sleep).toMatchObject({ total: "2h", average: "1h" });
  });

  it("reports no average when every sleep is still incomplete", () => {
    const stats = buildReportStats([
      sleepLog("running", null),
      sleepLog("paused", null),
      sleepLog("none", null)
    ], null, timeZone, defaultUnitPreferences);

    expect(stats.byType.sleep).toBe(3);
    expect(stats.sleep).toMatchObject({ total: "0 min", average: "0 min" });
  });
});

describe("report growth statistics", () => {
  it("normalizes mixed growth units into the household preferences", () => {
    const stats = buildReportStats(
      [
        statsActivity(ActivityType.measurement, {
          measurement: {
            weight: "2.2046226218",
            weightUnit: "lb",
            length: "1",
            lengthUnit: "in",
            headCircumference: "2",
            headUnit: "in"
          }
        }),
        statsActivity(ActivityType.measurement, {
          measurement: {
            weight: "1",
            weightUnit: "kg",
            length: "2.54",
            lengthUnit: "cm",
            headCircumference: "5.08",
            headUnit: "cm"
          }
        })
      ],
      null,
      timeZone,
      { ...defaultUnitPreferences, weight: "kg", length: "cm" }
    );

    expect(stats.growth.weight?.map(({ value, unit }) => ({ value, unit }))).toEqual([
      { value: 1, unit: "kg" },
      { value: 1, unit: "kg" }
    ]);
    expect(stats.growth.length?.map(({ value, unit }) => ({ value, unit }))).toEqual([
      { value: 2.54, unit: "cm" },
      { value: 2.54, unit: "cm" }
    ]);
    expect(stats.growth.head?.map(({ value, unit }) => ({ value, unit }))).toEqual([
      { value: 5.08, unit: "cm" },
      { value: 5.08, unit: "cm" }
    ]);
  });

  it("fails a growth series closed when an explicit unit is unsupported", () => {
    const stats = buildReportStats(
      [
        statsActivity(ActivityType.measurement, {
          measurement: {
            weight: "10",
            weightUnit: "stone",
            length: "20",
            lengthUnit: "in"
          }
        })
      ],
      null,
      timeZone,
      defaultUnitPreferences
    );

    expect(stats.growth.weight).toBeNull();
    expect(stats.growth.length).toEqual([expect.objectContaining({ value: 20, unit: "in" })]);
  });
});

describe("reports routine", () => {
  it("builds trailing windows anchored to the report end date", () => {
    expect(routineWindowRange("2026-06-19", "1w", timeZone)).toMatchObject({
      startKey: "2026-06-13",
      endKey: "2026-06-19",
      days: 7
    });
    expect(routineWindowRange("2026-06-19", "2w", timeZone)).toMatchObject({
      startKey: "2026-06-06",
      endKey: "2026-06-19",
      days: 14
    });
    expect(routineWindowRange("2026-06-19", "1m", timeZone)).toMatchObject({
      startKey: "2026-05-21",
      endKey: "2026-06-19",
      days: 30
    });
    expect(routineWindowRange("2026-06-19", "1w", timeZone).start.toISOString()).toBe("2026-06-13T04:00:00.000Z");
    expect(routineWindowRange("2026-06-19", "1w", timeZone).endExclusive.toISOString()).toBe("2026-06-20T04:00:00.000Z");
  });

  it("runs a timed activity from its start to its end, or its recorded length when it has no end", () => {
    const occurredAt = local("2026-06-19T19:00");
    const [timed, manual, running] = routineEventsFrom([
      { type: "sleep", occurredAt, startedAt: local("2026-06-19T19:10"), endedAt: local("2026-06-20T06:30"), durationSeconds: 999 },
      { type: "sleep", occurredAt, startedAt: null, endedAt: null, durationSeconds: 3600 },
      { type: "sleep", occurredAt, startedAt: occurredAt, endedAt: null, durationSeconds: null }
    ]);

    expect(timed).toEqual({ type: "sleep", start: local("2026-06-19T19:10"), end: local("2026-06-20T06:30") });
    expect(manual).toEqual({ type: "sleep", start: occurredAt, end: local("2026-06-19T20:00") });
    expect(running).toEqual({ type: "sleep", start: occurredAt, end: null });
  });

  it("reads the window ending on the report's end date, with the night before it for the first morning", () => {
    const records = [];
    for (let offset = -1; offset < 7; offset += 1) {
      const key = addDaysToDateKey("2026-06-13", offset);
      const next = addDaysToDateKey(key, 1);
      records.push({ type: "sleep", occurredAt: local(`${key}T19:00`), startedAt: local(`${key}T19:00`), endedAt: local(`${next}T06:00`), durationSeconds: null });
    }
    const routine = buildRoutine(records, "2026-06-19", "1w", timeZone);

    expect(routine).toMatchObject({ window: "1w", windowLabel: "1 week", startKey: "2026-06-13", endKey: "2026-06-19" });
    expect(routine.wake).toMatchObject({ time: "6:00 AM", days: 7 });
    expect(routine.bedtime).toMatchObject({ time: "7:00 PM", days: 7 });
  });
});

function local(localDateTime: string) {
  return zonedDateTimeToDate(localDateTime, timeZone);
}

function sleepLog(
  timerState: "none" | "running" | "paused" | "stopped",
  durationSeconds: number | null,
  sleepType: "nap" | "night" = "nap"
) {
  return statsActivity(ActivityType.sleep, { timerState, durationSeconds, sleep: { sleepType } });
}

function statsActivity(
  type: ActivityType,
  detail: Record<string, unknown>
): Parameters<typeof buildReportStats>[0][number] {
  return {
    type,
    occurredAt: zonedDateTimeToDate("2026-06-19T08:00", timeZone),
    durationSeconds: null,
    ...detail
  } as Parameters<typeof buildReportStats>[0][number];
}
