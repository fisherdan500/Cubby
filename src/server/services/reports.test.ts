import { ActivityType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { defaultUnitPreferences } from "@/domain/unit-preferences";
import { zonedDateTimeToDate } from "@/lib/timezone";
import { buildReportStats, buildRoutineTimeline, routineWindowRange } from "@/server/services/reports";

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

describe("reports routine timeline", () => {
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

  it("aligns sleep and feed events by event order across days", () => {
    const routine = buildRoutineTimeline(
      [
        activity(ActivityType.sleep, "2026-06-18T07:00", 30 * 60),
        activity(ActivityType.feeding, "2026-06-18T08:00"),
        activity(ActivityType.sleep, "2026-06-19T07:30", 40 * 60),
        activity(ActivityType.feeding, "2026-06-19T08:30")
      ],
      "2026-06-19",
      "1w",
      timeZone
    );

    expect(routine.daysWithData).toBe(2);
    expect(routine.summary.averageSleepDuration).toBe("35 min");
    expect(routine.rows).toEqual([
      expect.objectContaining({
        type: "sleep",
        averageTime: "7:15 AM",
        averageDuration: "35 min",
        sampleCount: 2
      }),
      expect.objectContaining({
        type: "feeding",
        averageTime: "8:15 AM",
        sampleCount: 2
      })
    ]);
  });

  it("counts all feeding activity positions without mode filtering", () => {
    const routine = buildRoutineTimeline(
      [
        activity(ActivityType.feeding, "2026-06-19T08:00"),
        activity(ActivityType.feeding, "2026-06-19T10:00"),
        activity(ActivityType.feeding, "2026-06-19T12:00"),
        activity(ActivityType.feeding, "2026-06-19T14:00")
      ],
      "2026-06-19",
      "1w",
      timeZone
    );

    expect(routine.summary.feedSamples).toBe(4);
    expect(routine.rows.map((row) => row.type)).toEqual(["feeding", "feeding", "feeding", "feeding"]);
  });

  it("aligns each activity type independently before sorting the typical day", () => {
    const routine = buildRoutineTimeline(
      [
        activity(ActivityType.feeding, "2026-06-18T07:00"),
        activity(ActivityType.diaper, "2026-06-18T07:20"),
        activity(ActivityType.sleep, "2026-06-18T08:00", 30 * 60),
        activity(ActivityType.feeding, "2026-06-18T10:00"),
        activity(ActivityType.feeding, "2026-06-19T07:30"),
        activity(ActivityType.diaper, "2026-06-19T07:50"),
        activity(ActivityType.sleep, "2026-06-19T08:30", 40 * 60),
        activity(ActivityType.feeding, "2026-06-19T10:30")
      ],
      "2026-06-19",
      "1w",
      timeZone
    );

    expect(routine.rows.map(({ type, index, averageTime }) => ({ type, index, averageTime }))).toEqual([
      { type: "feeding", index: 0, averageTime: "7:15 AM" },
      { type: "diaper", index: 0, averageTime: "7:35 AM" },
      { type: "sleep", index: 0, averageTime: "8:15 AM" },
      { type: "feeding", index: 1, averageTime: "10:15 AM" }
    ]);
  });

  it("counts samples for every supported routine activity type", () => {
    const routine = buildRoutineTimeline(
      [
        activity(ActivityType.sleep, "2026-06-19T07:00", 30 * 60),
        activity(ActivityType.feeding, "2026-06-19T08:00"),
        activity(ActivityType.feeding, "2026-06-19T10:00"),
        activity(ActivityType.diaper, "2026-06-19T08:30")
      ],
      "2026-06-19",
      "1w",
      timeZone
    );

    expect(routine.summary.samplesByType).toMatchObject({
      sleep: 1,
      feeding: 2,
      diaper: 1,
      pumping: 0,
      medicine: 0,
      supplement: 0,
      bath: 0,
      play: 0
    });
  });

  it("includes approved routine types and excludes event or subjective types", () => {
    const routine = buildRoutineTimeline(
      [
        activity(ActivityType.play, "2026-06-19T09:00"),
        activity(ActivityType.medicine, "2026-06-19T10:00"),
        activity(ActivityType.mood, "2026-06-19T11:00"),
        activity(ActivityType.note, "2026-06-19T12:00"),
        activity(ActivityType.measurement, "2026-06-19T13:00"),
        activity(ActivityType.milestone, "2026-06-19T14:00"),
        activity(ActivityType.vaccine, "2026-06-19T15:00"),
        activity(ActivityType.milk_inventory, "2026-06-19T16:00")
      ],
      "2026-06-19",
      "1w",
      timeZone
    );

    expect(routine.rows.map((row) => row.type)).toEqual(["play", "medicine"]);
    expect(routine.summary.samplesByType).not.toHaveProperty("mood");
  });

  it("uses the configured timezone for local day and time grouping", () => {
    const routine = buildRoutineTimeline(
      [{ type: ActivityType.feeding, occurredAt: new Date("2026-06-19T03:30:00.000Z"), durationSeconds: null }],
      "2026-06-18",
      "1w",
      timeZone
    );

    expect(routine.daysWithData).toBe(1);
    expect(routine.rows[0]).toMatchObject({
      type: "feeding",
      averageTime: "11:30 PM"
    });
  });

  it("averages routine clock times across midnight without shifting them to noon", () => {
    const routine = buildRoutineTimeline(
      [
        activity(ActivityType.play, "2026-06-18T23:50"),
        activity(ActivityType.feeding, "2026-06-18T23:40"),
        activity(ActivityType.play, "2026-06-19T00:10"),
        activity(ActivityType.feeding, "2026-06-19T00:20")
      ],
      "2026-06-19",
      "1w",
      timeZone
    );

    expect(routine.summary.averageFeedTime).toBe("12:00 AM");
    expect(routine.rows.map(({ type, averageTime }) => ({ type, averageTime }))).toEqual([
      { type: "feeding", averageTime: "12:00 AM" },
      { type: "play", averageTime: "12:00 AM" }
    ]);
  });

  it("omits sparse sequence positions", () => {
    const routine = buildRoutineTimeline(
      [
        activity(ActivityType.feeding, "2026-06-16T08:00"),
        activity(ActivityType.sleep, "2026-06-16T09:00", 30 * 60),
        activity(ActivityType.feeding, "2026-06-17T08:00"),
        activity(ActivityType.feeding, "2026-06-18T08:00"),
        activity(ActivityType.feeding, "2026-06-19T08:00")
      ],
      "2026-06-19",
      "1w",
      timeZone
    );

    expect(routine.minSamples).toBe(2);
    expect(routine.rows).toEqual([
      expect.objectContaining({
        type: "feeding",
        averageTime: "8:00 AM",
        sampleCount: 4
      })
    ]);
  });
});

function activity(type: ActivityType, localDateTime: string, durationSeconds: number | null = null) {
  return {
    type,
    occurredAt: zonedDateTimeToDate(localDateTime, timeZone),
    durationSeconds
  };
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
