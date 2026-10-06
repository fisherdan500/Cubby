import { describe, expect, it } from "vitest";
import { buildTrends, type TrendActivity } from "@/server/services/trends";
import { addDaysToDateKey, zonedDateTimeToDate } from "@/lib/timezone";

const timeZone = "America/New_York";

function at(localDateTime: string) {
  return zonedDateTimeToDate(localDateTime, timeZone);
}

function feed(
  localDateTime: string,
  amount: number | null = null,
  mode = amount === null ? "breast" : "bottle",
  unit: string | null = amount === null ? null : "oz"
) {
  return {
    type: "feeding" as const,
    occurredAt: at(localDateTime),
    startedAt: null,
    endedAt: null,
    durationSeconds: null,
    timerState: "none",
    pausedAt: null,
    feedingAmount: amount,
    feedingMode: mode,
    feedingUnit: unit,
    diaperKind: null
  };
}

function diaper(localDateTime: string, kind: TrendActivity["diaperKind"] = null) {
  return {
    type: "diaper" as const,
    occurredAt: at(localDateTime),
    startedAt: null,
    endedAt: null,
    durationSeconds: null,
    timerState: "none",
    pausedAt: null,
    feedingAmount: null,
    feedingMode: null,
    diaperKind: kind
  };
}

function sleep(startLocal: string, endLocal: string | null, options: { timerState?: string } = {}) {
  const endedAt = endLocal === null ? null : at(endLocal);
  return {
    type: "sleep" as const,
    occurredAt: at(startLocal),
    startedAt: at(startLocal),
    endedAt,
    durationSeconds: endedAt === null ? null : Math.round((endedAt.getTime() - at(startLocal).getTime()) / 1000),
    timerState: options.timerState ?? "stopped",
    pausedAt: null,
    feedingAmount: null,
    feedingMode: null,
    diaperKind: null
  };
}

/** A week of ordinary days, so a single deliberate oddity can be measured against it. */
function ordinaryWeek(from: string, feedsPerDay = 5) {
  const activities = [];
  for (let day = 0; day < 7; day += 1) {
    const date = `2026-06-0${day + 1}`;
    for (let n = 0; n < feedsPerDay; n += 1) {
      activities.push(feed(`${date}T${String(7 + n * 3).padStart(2, "0")}:00`));
    }
  }
  return activities;
}

describe("trends", () => {
  describe("resolved window", () => {
    const options = {
      timeZone,
      now: at("2026-06-10T12:00").getTime(),
      window: { from: at("2026-06-01T00:00"), to: at("2026-06-04T00:00") }
    };

    it.each([true, false])("rejects old duration-only rows but retains window overlap with startedAt=%s", (hasStart) => {
      const durationOnly = (start: string, durationSeconds: number) => ({
        ...sleep(start, null, { timerState: "none" }),
        startedAt: hasStart ? at(start) : null,
        durationSeconds
      });
      const old = durationOnly("2020-06-01T12:00", 3600);
      expect(buildTrends([old], options).anyData).toBe(false);

      const result = buildTrends([
        old,
        durationOnly("2026-05-31T23:30", 3600),
        durationOnly("2026-06-02T00:00", 1800),
        durationOnly("2026-06-03T00:00", 1800)
      ], options);

      expect(result.startKey).toBe("2026-06-01");
      expect(result.endKey).toBe("2026-06-03");
      expect(result.sleep.points).toEqual([
        { weekKey: "2026-06-01", value: 1800, daysCounted: 3, daysLogged: 3, daysUnknown: 0 }
      ]);
      for (const key of ["daytimeSleep", "nighttimeSleep"] as const) {
        expect(result[key].points.map((point) => point.weekKey)).toEqual(["2026-06-01"]);
      }
    });

    it("rejects instant records and nonoverlapping sleeps outside the half-open window", () => {
      const inside = [feed("2026-06-01T00:00"), diaper("2026-06-03T23:59", "mixed")];
      const outside = [
        feed("2026-05-31T23:59"), feed("2026-06-04T00:00"),
        diaper("2026-05-31T23:59", "wet"), diaper("2026-06-04T00:00", "dirty"),
        sleep("2026-05-31T23:00", "2026-06-01T00:00"),
        sleep("2026-06-04T00:00", "2026-06-04T01:00")
      ];

      expect(buildTrends([...outside, ...inside], options)).toEqual(buildTrends(inside, options));
    });

    it("retains genuinely long finished sleep without extending the resolved window", () => {
      const result = buildTrends([sleep("2020-06-01T00:00", "2026-06-05T00:00")], {
        ...options,
        window: { from: at("2026-06-01T00:00"), to: at("2026-06-05T00:00") }
      });

      expect(result).toMatchObject({ startKey: "2026-06-01", endKey: "2026-06-04", weeks: 1 });
      expect(result.sleep.points).toEqual([
        { weekKey: "2026-06-01", value: 86400, daysCounted: 4, daysLogged: 4, daysUnknown: 0 }
      ]);
      for (const key of ["daytimeSleep", "nighttimeSleep"] as const) {
        expect(result[key].points).toEqual([
          { weekKey: "2026-06-01", value: 43200, daysCounted: 3, daysLogged: 3, daysUnknown: 0 }
        ]);
      }
    });
  });

  describe("split sleep", () => {
    it("keeps three completed Kiritimati Friday Saturday Sunday nights in one Monday week", () => {
      const zone = "Pacific/Kiritimati";
      const activities = ["2026-06-05", "2026-06-06", "2026-06-07"].map((key) => {
        const startedAt = zonedDateTimeToDate(`${key}T19:00`, zone);
        const endedAt = zonedDateTimeToDate(`${addDaysToDateKey(key, 1)}T07:00`, zone);
        return {
          ...sleep(`${key}T19:00`, null),
          occurredAt: startedAt,
          startedAt,
          endedAt,
          durationSeconds: (endedAt.getTime() - startedAt.getTime()) / 1000
        };
      });

      const result = buildTrends(activities, {
        timeZone: zone,
        now: zonedDateTimeToDate("2026-06-09T12:00", zone).getTime()
      });

      expect(result.nighttimeSleep.points).toEqual([
        { weekKey: "2026-06-01", value: 43200, daysCounted: 3, daysLogged: 3, daysUnknown: 0 }
      ]);
    });

    it("deduplicates overlapping sleep time across both windows and indexes every covered reporting day", () => {
      const record = sleep("2026-06-01T07:00", "2026-06-04T07:00");
      const overlap = sleep("2026-06-02T18:00", "2026-06-03T08:00");
      const result = buildTrends([record, overlap], { timeZone, now: at("2026-06-06T12:00").getTime() });

      for (const key of ["daytimeSleep", "nighttimeSleep"] as const) {
        expect(result[key].points).toEqual([
          { weekKey: "2026-06-01", value: 43200, daysCounted: 3, daysLogged: 3, daysUnknown: 0 }
        ]);
      }
    });

    it("retains a finished reporting night when its only record occurred this morning", () => {
      const result = buildTrends([sleep("2026-06-08T01:00", "2026-06-08T07:00")], {
        timeZone, now: at("2026-06-08T08:00").getTime()
      });

      for (const key of ["daytimeSleep", "nighttimeSleep"] as const) {
        expect(result[key].points).toEqual([
          { weekKey: "2026-06-01", value: null, daysCounted: 1, daysLogged: 1, daysUnknown: 0 }
        ]);
      }
      expect(result.sleep.points).toEqual([]);
      expect(result.anyData).toBe(true);
      expect(result.startKey).toBe("2026-06-07");
      expect(result.endKey).toBe("2026-06-07");
      expect(result.weeks).toBe(1);
    });

    it("preserves total-sleep midnight outputs and blank week gaps for overnight records", () => {
      const activities = [0, 1, 2, 14, 15, 16].map((offset) => {
        const key = addDaysToDateKey("2026-06-01", offset);
        return sleep(`${key}T19:00`, `${addDaysToDateKey(key, 1)}T07:00`);
      });
      const result = buildTrends(activities, { timeZone, now: at("2026-06-22T12:00").getTime() });

      expect(result.sleep.points).toEqual([
        { weekKey: "2026-06-01", value: 32400, daysCounted: 4, daysLogged: 4, daysUnknown: 0 },
        { weekKey: "2026-06-08", value: null, daysCounted: 0, daysLogged: 0, daysUnknown: 0 },
        { weekKey: "2026-06-15", value: 32400, daysCounted: 4, daysLogged: 4, daysUnknown: 0 }
      ]);
      for (const key of ["daytimeSleep", "nighttimeSleep"] as const) {
        expect(result[key].points.map((point) => point.weekKey)).toEqual(["2026-06-01", "2026-06-08", "2026-06-15"]);
        expect(result[key].points.map((point) => point.value)).toEqual(key === "daytimeSleep" ? [0, null, 0] : [43200, null, 43200]);
      }
    });

    it("withholds both halves until ending 7 AM while retaining genuine running sleep and excluding forgotten timers", () => {
      const activities = [1, 2, 3].map((day) => sleep(`2026-06-0${day}T19:00`, `2026-06-0${day + 1}T07:00`));
      const running = sleep("2026-06-04T19:00", null, { timerState: "running" });
      const boundary = at("2026-06-05T07:00").getTime();
      const before = buildTrends([...activities, running], { timeZone, now: boundary - 1000 });

      expect(before.nighttimeSleep.points[0]).toMatchObject({ value: 43200, daysCounted: 3, daysLogged: 3 });
      expect(before.daytimeSleep.points[0]).toMatchObject({ value: 0, daysCounted: 3, daysLogged: 3 });
      expect(before.sleep).not.toEqual(buildTrends(activities, { timeZone, now: boundary - 1000 }).sleep);

      for (const now of [boundary, boundary + 1000]) {
        const result = buildTrends([...activities, running], { timeZone, now });
        expect(result.nighttimeSleep.points[0]).toMatchObject({ value: 43200, daysCounted: 4, daysLogged: 4 });
        expect(result.daytimeSleep.points[0]).toMatchObject({ value: 0, daysCounted: 4, daysLogged: 4 });
        const forgotten = { ...running, occurredAt: new Date(now - 2 * 86400000 - 1), startedAt: new Date(now - 2 * 86400000 - 1) };
        expect(buildTrends([...activities, running, forgotten], { timeZone, now })).toEqual(result);
      }
    });

    it("leaves unknown legacy pause and duration placement unavailable with honest daysUnknown", () => {
      for (const pausedSeconds of [3600, 0]) {
        const activities: TrendActivity[] = [1, 2, 3, 4].flatMap((day) => [
          sleep(`2026-06-0${day}T10:00`, `2026-06-0${day}T11:00`),
          sleep(`2026-06-0${day}T20:00`, `2026-06-0${day}T21:00`)
        ]);
        activities.push({ ...sleep("2026-06-04T18:00", "2026-06-04T20:00"), durationSeconds: 3600, pausedSeconds });
        const options = { timeZone, now: at("2026-06-06T12:00").getTime() };
        const result = buildTrends(activities, options);

        for (const key of ["daytimeSleep", "nighttimeSleep"] as const) {
          expect(result[key].points[0]).toEqual({
            weekKey: "2026-06-01", value: 3600, daysCounted: 3, daysLogged: 4, daysUnknown: 1
          });
          expect(buildTrends(activities.slice(2), options)[key].points[0]).toMatchObject({
            value: null, daysCounted: 2, daysLogged: 3, daysUnknown: 1
          });
        }
      }
    });

    it("uses full reporting-day entry counts for both halves while still excluding thin days", () => {
      const activities: TrendActivity[] = [];
      for (const day of [1, 2, 3, 4, 5, 6, 7]) {
        // Three days with four daytime records, three with four nighttime records, one thin day.
        const hours = day <= 3 ? [8, 10, 12, 14] : day <= 6 ? [19, 20, 21, 22] : [8];
        for (const hour of hours) {
          const start = `2026-06-0${day}T${String(hour).padStart(2, "0")}`;
          activities.push(sleep(`${start}:00`, `${start}:30`));
        }
      }
      const result = buildTrends(activities, { timeZone, now: at("2026-06-09T12:00").getTime() });

      for (const key of ["daytimeSleep", "nighttimeSleep"] as const) {
        expect(result[key].points).toEqual([
          { weekKey: "2026-06-01", value: 3600, daysCounted: 6, daysLogged: 7, daysUnknown: 0 }
        ]);
      }
    });

    it("reports known zero in the opposite half of a daytime-only or nighttime-only reporting day", () => {
      for (const [start, end, known, zero] of [
        ["10:00", "12:00", "daytimeSleep", "nighttimeSleep"],
        ["20:00", "22:00", "nighttimeSleep", "daytimeSleep"]
      ] as const) {
        const activities = [1, 2, 3].map((day) => sleep(`2026-06-0${day}T${start}`, `2026-06-0${day}T${end}`));
        const result = buildTrends(activities, { timeZone, now: at("2026-06-05T12:00").getTime() });

        expect(result[known].points[0]).toMatchObject({ value: 7200, daysCounted: 3, daysLogged: 3, daysUnknown: 0 });
        expect(result[zero].points[0]).toMatchObject({ value: 0, daysCounted: 3, daysLogged: 3, daysUnknown: 0 });
      }
    });

    it("uses eleven spring-forward and thirteen fall-back hours for fully asleep nights", () => {
      for (const [firstKey, transitionHours] of [["2026-03-05", 11], ["2026-10-29", 13]] as const) {
        const activities = [0, 1, 2].map((offset) => {
          const key = addDaysToDateKey(firstKey, offset);
          return sleep(`${key}T19:00`, `${addDaysToDateKey(key, 1)}T07:00`);
        });
        const result = buildTrends(activities, { timeZone, now: at(`${addDaysToDateKey(firstKey, 4)}T12:00`).getTime() });

        expect(activities[2].durationSeconds).toBe(transitionHours * 3600);
        expect(result.nighttimeSleep.points[0]).toMatchObject({ daysCounted: 3, daysLogged: 3, daysUnknown: 0 });
        expect(result.nighttimeSleep.points[0].value! * 3 - 24 * 3600).toBe(transitionHours * 3600);
        expect(result.daytimeSleep.points[0].value).toBe(0);
      }
    });

    it("subtracts precise pauses crossing both 7 AM and 7 PM from their actual halves", () => {
      const activities: TrendActivity[] = [2, 4, 6].flatMap((day) => [6, 18].map((hour) => {
        const date = `2026-06-0${day}`;
        const start = `${date}T${String(hour).padStart(2, "0")}:00`;
        return {
          ...sleep(start, `${date}T${String(hour + 2).padStart(2, "0")}:00`),
          durationSeconds: 5400,
          pausedSeconds: 1800,
          pauseTrackingStartedAt: at(start),
          pauseIntervals: [{
            startedAt: at(`${date}T${String(hour).padStart(2, "0")}:45`),
            endedAt: at(`${date}T${String(hour + 1).padStart(2, "0")}:15`)
          }]
        };
      }));
      const result = buildTrends(activities, { timeZone, now: at("2026-06-08T12:00").getTime() });

      for (const key of ["daytimeSleep", "nighttimeSleep"] as const) {
        expect(result[key].points).toEqual([
          { weekKey: "2026-06-01", value: 2700, daysCounted: 6, daysLogged: 6, daysUnknown: 0 }
        ]);
      }
    });

    it("owns Sunday-to-Monday sleep in Sunday's week even when the record starts after midnight", () => {
      const activities = [
        sleep("2026-06-05T19:00", "2026-06-06T07:00"),
        sleep("2026-06-06T19:00", "2026-06-07T07:00"),
        sleep("2026-06-08T01:00", "2026-06-08T07:00")
      ];
      const result = buildTrends(activities, { timeZone, now: at("2026-06-09T12:00").getTime() });

      expect(result.nighttimeSleep.points).toEqual([
        { weekKey: "2026-06-01", value: 36000, daysCounted: 3, daysLogged: 3, daysUnknown: 0 }
      ]);
      expect(result.daytimeSleep.points[0]).toMatchObject({ weekKey: "2026-06-01", value: 0, daysCounted: 3 });
    });

    it("keeps exact 7 AM and 7 PM boundaries half-open without extra reporting days", () => {
      const activities = [1, 2, 3].flatMap((day) => [
        sleep(`2026-06-0${day}T07:00`, `2026-06-0${day}T19:00`),
        sleep(`2026-06-0${day}T19:00`, `2026-06-0${day + 1}T07:00`)
      ]);
      const result = buildTrends(activities, { timeZone, now: at("2026-06-06T12:00").getTime() });

      for (const key of ["daytimeSleep", "nighttimeSleep"] as const) {
        expect(result[key].points).toEqual([
          { weekKey: "2026-06-01", value: 43200, daysCounted: 3, daysLogged: 3, daysUnknown: 0 }
        ]);
      }
      expect(result.daytimeSleep.points[0].value! + result.nighttimeSleep.points[0].value!).toBe(86400);
    });

    it("splits complete reporting days by actual overlap without changing total sleep", () => {
      const activities = [1, 2, 3].flatMap((day) => [
        sleep(`2026-06-0${day}T10:00`, `2026-06-0${day}T12:00`),
        sleep(`2026-06-0${day}T18:30`, `2026-06-0${day}T20:30`)
      ]);
      const result = buildTrends(activities, { timeZone, now: at("2026-06-05T12:00").getTime() });

      expect(result.daytimeSleep.points).toEqual([
        { weekKey: "2026-06-01", value: 9000, daysCounted: 3, daysLogged: 3, daysUnknown: 0 }
      ]);
      expect(result.nighttimeSleep.points).toEqual([
        { weekKey: "2026-06-01", value: 5400, daysCounted: 3, daysLogged: 3, daysUnknown: 0 }
      ]);
      expect(result.sleep.points).toEqual([
        { weekKey: "2026-06-01", value: 14400, daysCounted: 3, daysLogged: 3, daysUnknown: 0 }
      ]);
    });
  });

  it("counts feeds per complete day, by week", () => {
    const trends = buildTrends(ordinaryWeek("2026-06-01"), { timeZone, now: at("2026-06-08T12:00").getTime() });

    const [week] = trends.feeds.points;
    expect(week.weekKey).toBe("2026-06-01");
    expect(week.value).toBeCloseTo(5, 5);
    expect(week.daysCounted).toBe(7);
  });

  it("does not let a day somebody logged once drag the week down", () => {
    // The User's sitter case: six ordinary days, then a day with a single feed recorded.
    const activities = [...ordinaryWeek("2026-06-01").filter((item) => !item.occurredAt.toISOString().startsWith("2026-06-07")), feed("2026-06-07T09:00")];

    const [week] = buildTrends(activities, { timeZone, now: at("2026-06-08T12:00").getTime() }).feeds.points;

    // 30 feeds over the 6 complete days, not 31 over 7.
    expect(week.value).toBeCloseTo(5, 5);
    expect(week.daysCounted).toBe(6);
    expect(week.daysLogged).toBe(7);
  });

  it("counts a diaper change once, whatever was in it", () => {
    const activities = [diaper("2026-06-01T08:00"), diaper("2026-06-01T12:00"), diaper("2026-06-02T08:00"), diaper("2026-06-03T08:00")];

    const [week] = buildTrends(activities, { timeZone, now: at("2026-06-08T12:00").getTime() }).diapers.points;

    expect(week.value).toBeCloseTo(4 / 3, 5);
  });

  describe("wet and dirty diapers", () => {
    const now = at("2026-06-22T12:00").getTime();
    const changes = (day: number, kinds: TrendActivity["diaperKind"][]) => kinds.map((kind, index) =>
      diaper(`2026-06-${String(day).padStart(2, "0")}T${String(8 + index).padStart(2, "0")}:00`, kind)
    );

    it.each([
      ["wet", 1, 0], ["dirty", 0, 1], ["mixed", 1, 1], ["dry", 0, 0]
    ] as const)("counts %s once in total and only in its applicable subtypes", (kind, wet, dirty) => {
      const activities = [1, 2, 3].flatMap((day) => changes(day, [kind]));
      const trends = buildTrends(activities, { timeZone, now });

      expect(trends.diapers.points[0]).toMatchObject({ value: 1, daysCounted: 3, daysLogged: 3 });
      expect(trends.wetDiapers?.points[0]).toMatchObject({ value: wet, daysCounted: 3, daysUnknown: 0 });
      expect(trends.dirtyDiapers?.points[0]).toMatchObject({ value: dirty, daysCounted: 3, daysUnknown: 0 });
    });

    it("adds wet plus mixed and dirty plus mixed without changing total diaper counts", () => {
      const activities = [1, 2, 3].flatMap((day) => changes(day, ["wet", "wet", "dirty", "mixed", "dry"]));
      const trends = buildTrends(activities, { timeZone, now });

      expect(trends.diapers.points[0].value).toBe(5);
      expect(trends.wetDiapers?.points[0].value).toBe(3);
      expect(trends.dirtyDiapers?.points[0].value).toBe(2);
    });

    it.each([
      ["wetDiapers", "wet", "dirty"], ["dirtyDiapers", "dirty", "wet"]
    ] as const)("uses all changes as %s completeness evidence, retaining opposite-only zero days", (key, kind, opposite) => {
      const activities = [1, 2, 3].flatMap((day) => changes(day, Array(6).fill(kind)));
      for (const day of [4, 5, 6, 7]) activities.push(...changes(day, [opposite, opposite, "dry", "dry", "dry", "dry"]));
      const trends = buildTrends(activities, { timeZone, now });

      expect(trends[key]?.points[0]).toEqual({
        weekKey: "2026-06-01", value: 18 / 7, daysCounted: 7, daysLogged: 7, daysUnknown: 0
      });
      expect(trends[key]?.daysCounted).toBe(7);
      expect(trends.diapers.points[0].value).toBe(6);
    });

    it.each([
      ["wetDiapers", "wet"], ["dirtyDiapers", "dirty"]
    ] as const)("retains well-logged days with a low %s subtype count", (key, kind) => {
      const activities = [1, 2, 3].flatMap((day) => changes(day, Array(6).fill(kind)));
      for (const day of [4, 5, 6, 7]) activities.push(...changes(day, [kind, "dry", "dry", "dry", "dry", "dry"]));
      const trends = buildTrends(activities, { timeZone, now });

      expect(trends[key]?.points[0]).toMatchObject({ value: 22 / 7, daysCounted: 7, daysLogged: 7 });
    });

    it("still excludes incomplete days from total, wet and dirty averages", () => {
      const activities = [1, 2, 3].flatMap((day) => changes(day, ["wet", "dirty", "mixed", "dry", "dry", "dry"]));
      for (const day of [4, 5, 6, 7]) activities.push(...changes(day, ["mixed"]));
      const trends = buildTrends(activities, { timeZone, now });

      for (const [key, value] of [["diapers", 6], ["wetDiapers", 2], ["dirtyDiapers", 2]] as const) {
        expect(trends[key]?.points[0]).toMatchObject({ value, daysCounted: 3, daysLogged: 7, daysUnknown: 0 });
      }
    });

    it("keeps missing weeks and insufficiently logged weeks blank for every diaper measure", () => {
      const activities = [1, 2, 3, 15, 16].flatMap((day) => changes(day, ["mixed"]));
      const trends = buildTrends(activities, { timeZone, now });

      for (const key of ["diapers", "wetDiapers", "dirtyDiapers"] as const) {
        expect(trends[key]?.points).toEqual([
          { weekKey: "2026-06-01", value: 1, daysCounted: 3, daysLogged: 3, daysUnknown: 0 },
          { weekKey: "2026-06-08", value: null, daysCounted: 0, daysLogged: 0, daysUnknown: 0 },
          { weekKey: "2026-06-15", value: null, daysCounted: 2, daysLogged: 2, daysUnknown: 0 }
        ]);
      }
    });

    it("excludes today in the household timezone and cannot use it to complete a week", () => {
      const activities = [1, 2, 3, 4].flatMap((day) => changes(day, ["mixed", "mixed", "mixed"]));
      for (const [localNow, daysCounted, value] of [["2026-06-03T23:30", 2, null], ["2026-06-04T23:30", 3, 3]] as const) {
        const trends = buildTrends(activities, { timeZone, now: at(localNow).getTime() });
        for (const key of ["diapers", "wetDiapers", "dirtyDiapers"] as const) {
          expect(trends[key]?.points[0]).toMatchObject({ value, daysCounted, daysLogged: daysCounted });
        }
      }
      const todayOnly = buildTrends(changes(4, ["mixed"]), { timeZone, now: at("2026-06-04T23:30").getTime() });
      expect(todayOnly.anyData).toBe(false);
      expect(todayOnly.wetDiapers).toEqual({ points: [], daysCounted: 0 });
      expect(todayOnly.dirtyDiapers).toEqual({ points: [], daysCounted: 0 });
    });

    it("keeps a missing diaper kind unknown without losing its total change", () => {
      const activities = [1, 2, 3].flatMap((day) => changes(day, ["mixed", "dry"]));
      activities.push(...changes(4, [null, "mixed"]));
      const trends = buildTrends(activities, { timeZone, now });

      expect(trends.diapers.points[0]).toMatchObject({ value: 2, daysCounted: 4, daysUnknown: 0 });
      for (const key of ["wetDiapers", "dirtyDiapers"] as const) {
        expect(trends[key]?.points[0]).toMatchObject({ value: 1, daysCounted: 3, daysLogged: 4, daysUnknown: 1 });
      }
    });
  });

  describe("sleep", () => {
    it("splits an overnight sleep across the two days it covers, as the dashboard cards do", () => {
      // 19:00 to 07:00 is five hours on the first day and seven on the second. Attributing the whole
      // night to its start day would leave every morning reading as though nobody slept.
      const activities = [
        sleep("2026-06-01T19:00", "2026-06-02T07:00"),
        sleep("2026-06-02T19:00", "2026-06-03T07:00"),
        sleep("2026-06-03T19:00", "2026-06-04T07:00")
      ];

      const [week] = buildTrends(activities, { timeZone, now: at("2026-06-08T12:00").getTime() }).sleep.points;

      // Three nights of twelve hours are thirty-six hours of sleep, spread over four calendar days:
      // 5h on the 1st, 12h on each of the 2nd and 3rd (the tail of one night plus the head of the
      // next), and 7h on the 4th. The middle days are the point - each holds two part-nights.
      expect(week.daysCounted).toBe(4);
      expect(week.value).toBeCloseTo((36 * 3600) / 4, 0);
    });

    // Review found the window edge truncated: a night that began before the first day was never
    // consulted, so the first morning lost its tail. The caller reads from before the window for
    // exactly this reason, and the service must use what it is given rather than a fixed lookback.
    it("gives the first day the tail of a night that began before it", () => {
      const activities = [
        // Began the evening before the first day shown - the caller fetches this deliberately.
        sleep("2026-05-31T19:00", "2026-06-01T07:00"),
        sleep("2026-06-01T19:00", "2026-06-02T07:00"),
        sleep("2026-06-02T19:00", "2026-06-03T07:00"),
        sleep("2026-06-03T19:00", "2026-06-04T07:00")
      ];

      // Only 1 June and 2 June, so the week is exactly the two full days and nothing else dilutes
      // them. Review proved a week-level lower bound passed even with the night before ignored, so
      // this pins the value exactly: both days hold 7h of the night before plus 5h of their own.
      const twoDays = [activities[0], activities[1], activities[2]];
      const trends = buildTrends(twoDays, { timeZone, now: at("2026-06-10T12:00").getTime() });
      const week = trends.sleep.points.find((point) => point.weekKey === "2026-06-01");

      // 06-01: 7h + 5h. 06-02: 7h + 5h. 06-03: 7h tail only. Mean of 12, 12, 7.
      expect(week?.daysCounted).toBe(3);
      expect(week?.value).toBeCloseTo(((12 + 12 + 7) / 3) * 3600, 0);
    });

    it("counts every day a long sleep covers, not just the two it starts and ends beside", () => {
      // A thirty-hour entry is a mistake somebody made, but losing it silently is our mistake.
      const activities = [
        sleep("2026-06-01T20:00", "2026-06-03T02:00"),
        sleep("2026-06-04T19:00", "2026-06-05T07:00"),
        sleep("2026-06-05T19:00", "2026-06-06T07:00")
      ];

      const [week] = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).sleep.points;

      // 30h from the long entry plus 24h from the two nights, over the days they touch.
      const total = (week.value as number) * week.daysCounted;
      expect(total).toBeCloseTo(54 * 3600, -2);
    });

    it("reports sleep in seconds so the page can format it", () => {
      const activities = [sleep("2026-06-01T09:00", "2026-06-01T11:00"), sleep("2026-06-02T09:00", "2026-06-02T11:00"), sleep("2026-06-03T09:00", "2026-06-03T11:00")];

      const [week] = buildTrends(activities, { timeZone, now: at("2026-06-08T12:00").getTime() }).sleep.points;

      expect(week.value).toBeCloseTo(2 * 3600, 0);
    });
  });

  describe("volume", () => {
    it("stays blank when most of the bottles themselves went unmeasured", () => {
      // Breastfeeds no longer dilute this panel - they are not bottles - so what the guard still
      // protects against is a week of bottles somebody poured without recording the amount.
      const activities = [];
      for (let day = 1; day <= 5; day += 1) {
        for (let n = 0; n < 10; n += 1) {
          activities.push(feed(`2026-06-0${day}T${String(6 + n).padStart(2, "0")}:00`, null, "bottle", null));
        }
        activities.push(feed(`2026-06-0${day}T20:00`, 4, "bottle"));
      }

      const [week] = buildTrends(activities, { timeZone, now: at("2026-06-08T12:00").getTime() }).volume.points;

      // One bottle measured in eleven: reporting 4oz a day would read as near-starvation.
      expect(week.value).toBeNull();
    });

    it("weighs a day by the feeds it actually measured, not by all of them", () => {
      // Review: an unmeasured feed added nothing to the ounces but still carried its day at full
      // weight, so a week passing the guard with a tenth unmeasured under-reported intake by a
      // tenth. On a chart about how much a baby is taking, that is the wrong direction to be wrong.
      const activities = [];
      for (let dayOfMonth = 1; dayOfMonth <= 7; dayOfMonth += 1) {
        const date = String(dayOfMonth).padStart(2, "0");
        for (let n = 0; n < 10; n += 1) {
          const unmeasured = dayOfMonth === 1 && n < 7;
          // Unmeasured BOTTLES: poured but not recorded, so they belong in the panel's denominator.
          activities.push(
            unmeasured
              ? feed(`2026-06-${date}T${String(6 + n).padStart(2, "0")}:00`, null, "bottle", null)
              : feed(`2026-06-${date}T${String(6 + n).padStart(2, "0")}:00`, 4, "bottle")
          );
        }
      }

      const [week] = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).volume.points;

      // Every measured feed is 4oz, so the honest figure is 40oz a day however many went unrecorded.
      expect(week.value).toBeCloseTo(40, 1);
    });

    it("counts only the feeds this panel is about, not breastfeeds alongside them", () => {
      // Review: extrapolating measured ounces across EVERY feed read a breastfeed as though it were
      // another bottle, over-reporting intake by more than the under-report it replaced. A breastfeed
      // contributes no bottle volume at all; the app records which feeds are which, so use it.
      const activities = [];
      for (let dayOfMonth = 1; dayOfMonth <= 7; dayOfMonth += 1) {
        const date = String(dayOfMonth).padStart(2, "0");
        for (let n = 0; n < 9; n += 1) {
          activities.push(feed(`2026-06-${date}T${String(6 + n).padStart(2, "0")}:00`, 4, "bottle"));
        }
        activities.push(feed(`2026-06-${date}T20:00`, null, "breast"));
      }

      const [week] = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).volume.points;

      expect(week.value).toBeCloseTo(36, 1);
    });

    it("reads a week logged in millilitres as the same intake as one logged in ounces", () => {
      // Review: amounts were summed raw while the panel formatted them as ounces, so switching the
      // entry unit for a week drew a thirty-fold cliff on a chart that exists to show change.
      const activities = [];
      for (let dayOfMonth = 1; dayOfMonth <= 7; dayOfMonth += 1) {
        const date = String(dayOfMonth).padStart(2, "0");
        for (let n = 0; n < 8; n += 1) {
          activities.push(feed(`2026-06-${date}T${String(6 + n).padStart(2, "0")}:00`, 4, "bottle", "oz"));
        }
      }
      for (let dayOfMonth = 8; dayOfMonth <= 14; dayOfMonth += 1) {
        const date = String(dayOfMonth).padStart(2, "0");
        for (let n = 0; n < 8; n += 1) {
          activities.push(feed(`2026-06-${date}T${String(6 + n).padStart(2, "0")}:00`, 118.294, "bottle", "mL"));
        }
      }

      const points = buildTrends(activities, { timeZone, now: at("2026-06-20T12:00").getTime() }).volume.points;

      expect(points[0].value).toBeCloseTo(32, 0);
      expect(points[1].value).toBeCloseTo(32, 0);
    });

    it("leaves today out, so a day still in progress is not drawn as a drop", () => {
      // Review: feeds so far today were averaged against whole days, showing a dip that was only
      // the clock. Today is reported once it is over.
      const activities = [];
      for (let dayOfMonth = 1; dayOfMonth <= 5; dayOfMonth += 1) {
        const date = String(dayOfMonth).padStart(2, "0");
        for (let n = 0; n < 6; n += 1) activities.push(feed(`2026-06-${date}T${String(6 + n * 2).padStart(2, "0")}:00`));
      }
      // Three feeds logged by lunchtime on the 6th, which is "today".
      for (let n = 0; n < 3; n += 1) activities.push(feed(`2026-06-06T${String(7 + n * 2).padStart(2, "0")}:00`));

      const [week] = buildTrends(activities, { timeZone, now: at("2026-06-06T13:00").getTime() }).feeds.points;

      expect(week.value).toBeCloseTo(6, 5);
      expect(week.daysCounted).toBe(5);
    });

    it("reports a week where every feed was measured", () => {
      const activities = [];
      for (let day = 1; day <= 4; day += 1) {
        for (let n = 0; n < 5; n += 1) activities.push(feed(`2026-06-0${day}T${String(7 + n * 3).padStart(2, "0")}:00`, 5));
      }

      const [week] = buildTrends(activities, { timeZone, now: at("2026-06-08T12:00").getTime() }).volume.points;

      expect(week.value).toBeCloseTo(25, 5);
    });
  });

  it("leaves a week with too few days blank rather than drawing it low", () => {
    const activities = [feed("2026-06-01T08:00"), feed("2026-06-02T08:00")];

    const [week] = buildTrends(activities, { timeZone, now: at("2026-06-08T12:00").getTime() }).feeds.points;

    expect(week.value).toBeNull();
  });

  it("keeps weeks in order with their gaps in place", () => {
    const activities = [
      ...ordinaryWeek("2026-06-01"),
      // Nothing at all in the week of 8 June.
      feed("2026-06-15T08:00"), feed("2026-06-16T08:00"), feed("2026-06-17T08:00"), feed("2026-06-18T08:00")
    ];

    const points = buildTrends(activities, { timeZone, now: at("2026-06-22T12:00").getTime() }).feeds.points;

    expect(points.map((point) => point.weekKey)).toEqual(["2026-06-01", "2026-06-08", "2026-06-15"]);
    expect(points.map((point) => point.value !== null)).toEqual([true, false, true]);
  });

  it("says nothing at all when there is nothing logged", () => {
    const trends = buildTrends([], { timeZone, now: at("2026-06-08T12:00").getTime() });
    expect(trends.feeds.points).toEqual([]);
    expect(trends.anyData).toBe(false);
  });
  it("counts only what was poured, not a solids meal logged beside the bottles", () => {
    // FeedingKind has four values, so "not breast" is not the same as "bottle or formula". A puree
    // at dinner is not a bottle, and it must not inflate the count the ounces are spread across.
    const activities = [];
    for (let day = 1; day <= 7; day += 1) {
      const date = `2026-06-0${day}`;
      for (let n = 0; n < 9; n += 1) activities.push(feed(`${date}T${String(6 + n).padStart(2, "0")}:00`, 4, "bottle", "oz"));
      activities.push(feed(`${date}T18:00`, null, "solids", null));
    }

    const [week] = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).volume.points;

    expect(week.value).toBeCloseTo(36, 1);
  });

  it("leaves a solids amount out of a bottle total even when one was recorded", () => {
    const activities = [];
    for (let day = 1; day <= 7; day += 1) {
      const date = `2026-06-0${day}`;
      for (let n = 0; n < 9; n += 1) activities.push(feed(`${date}T${String(6 + n).padStart(2, "0")}:00`, 4, "bottle", "oz"));
      activities.push(feed(`${date}T18:00`, 3, "solids", "oz"));
    }

    const [week] = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).volume.points;

    expect(week.value).toBeCloseTo(36, 1);
  });

  it("will not report a day holding an amount it cannot read", () => {
    // A tablespoon is not a unit this converts, so that bottle's volume is simply unknown. The day
    // cannot be totalled honestly and is left out, rather than having the unknown bottle stand in
    // at the average of the others - which reported 40oz for a day that may have held 37.
    const activities = [];
    for (let day = 1; day <= 7; day += 1) {
      const date = `2026-06-0${day}`;
      for (let n = 0; n < 9; n += 1) activities.push(feed(`${date}T${String(6 + n).padStart(2, "0")}:00`, 4, "bottle", "oz"));
      activities.push(feed(`${date}T18:00`, 2, "bottle", "tbsp"));
    }

    const [week] = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).volume.points;

    expect(week.value).toBeNull();
  });

  it("reports the ounces that were actually recorded, never an estimate standing in for them", () => {
    // The invariant every earlier version of this panel broke: a reported figure must be the sum of
    // amounts that were really written down. Four rounds of defects all came from one unmeasured or
    // unreadable feed being replaced by the average of its neighbours, which inflated a day of
    // mostly-tablespoon bottles to three times its real volume.
    const shapes: Array<{ label: string; day: Array<[number | null, string, string | null]> }> = [
      { label: "one readable ounce among tablespoons", day: [[4, "bottle", "oz"], ...Array.from({ length: 9 }, () => [2, "bottle", "tbsp"] as [number, string, string]) ] },
      { label: "one readable ounce among millilitre-likes", day: [[1, "bottle", "oz"], ...Array.from({ length: 9 }, () => [240, "bottle", "cc"] as [number, string, string]) ] },
      { label: "a bottle nobody wrote an amount for", day: [[4, "bottle", "oz"], [4, "bottle", "oz"], [null, "bottle", null]] },
      { label: "every bottle readable", day: [[4, "bottle", "oz"], [6, "bottle", "oz"], [118.294, "bottle", "mL"]] }
    ];

    for (const shape of shapes) {
      const activities: ReturnType<typeof feed>[] = [];
      for (let day = 1; day <= 7; day += 1) {
        const date = `2026-06-0${day}`;
        shape.day.forEach(([amount, mode, unit], index) => {
          activities.push(feed(`${date}T${String(6 + index).padStart(2, "0")}:00`, amount, mode, unit));
        });
      }

      const [week] = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).volume.points;

      if (week.value === null) continue;
      // Every amount this can read, in ounces, across the days it counted.
      const readablePerDay = shape.day
        .filter(([amount, , unit]) => amount !== null && (unit === "oz" || unit === "mL"))
        .reduce((sum, [amount, , unit]) => sum + (unit === "mL" ? (amount as number) / 29.5735295625 : (amount as number)), 0);
      expect(week.value).toBeLessThanOrEqual(readablePerDay + 0.01);
    }
  });

  it("weighs the measured share by the feeds that could have carried an amount", () => {
    // The guard asks what share of the POURED feeds were measured. Counting breastfeeds in that
    // denominator blanks a bottle-fed week for the sin of also breastfeeding.
    const activities = [];
    for (let day = 1; day <= 7; day += 1) {
      const date = `2026-06-0${day}`;
      for (let n = 0; n < 4; n += 1) activities.push(feed(`${date}T${String(6 + n * 2).padStart(2, "0")}:00`, 4, "bottle", "oz"));
      for (let n = 0; n < 6; n += 1) activities.push(feed(`${date}T${String(15 + n).padStart(2, "0")}:00`, null, "breast", null));
    }

    const [week] = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).volume.points;

    expect(week.value).toBeCloseTo(16, 1);
  });

  it("ignores a timer someone forgot to stop instead of calling every day fully asleep", () => {
    // An unfinished timer is an unfinished log, not evidence of sleep. Spreading it across every day
    // it has been running drew a flat 24h line over a week that really held twelve-hour nights.
    const pad = (value: number) => String(value).padStart(2, "0");
    const activities: ReturnType<typeof sleep>[] = [
      sleep("2026-04-01T20:00", null, { timerState: "running" })
    ];
    for (let day = 1; day <= 7; day += 1) {
      activities.push(sleep(`2026-06-${pad(day)}T19:00`, `2026-06-${pad(day + 1)}T07:00`));
    }

    const points = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).sleep.points;
    const withoutTimer = buildTrends(activities.slice(1), { timeZone, now: at("2026-06-10T12:00").getTime() }).sleep.points;

    // The whole series, not one week: a timer wrongly counted on its start day alone would hide
    // outside whichever week a single assertion happened to inspect.
    expect(points.map((point) => point.value)).toEqual(withoutTimer.map((point) => point.value));
    const week = points.find((point) => point.weekKey === "2026-06-01");
    expect((week?.value ?? 0) / 3600).toBeLessThan(13);
  });

  it("still ignores it when the timer was left with no state and only a length", () => {
    // The same forgotten sleep, reached through durationSeconds instead of a running timer: an
    // unfinished row with a fortnight's length filed itself against every day in between.
    const pad = (value: number) => String(value).padStart(2, "0");
    const activities: ReturnType<typeof sleep>[] = [
      { ...sleep("2026-04-01T20:00", null), timerState: "none", durationSeconds: 70 * 24 * 60 * 60 }
    ];
    for (let day = 1; day <= 7; day += 1) {
      activities.push(sleep(`2026-06-${pad(day)}T19:00`, `2026-06-${pad(day + 1)}T07:00`));
    }

    const points = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).sleep.points;
    const withoutIt = buildTrends(activities.slice(1), { timeZone, now: at("2026-06-10T12:00").getTime() }).sleep.points;

    expect(points.map((point) => point.value)).toEqual(withoutIt.map((point) => point.value));
  });

  it("keeps a sleep that is genuinely still running tonight", () => {
    // The limit must not throw away real sleep in progress: a timer started last evening is an
    // ordinary night, not a forgotten one. Logged on a day with no other sleep, so that merging
    // overlapping intervals cannot hide whether it was counted.
    const pad = (value: number) => String(value).padStart(2, "0");
    const activities: ReturnType<typeof sleep>[] = [];
    for (let day = 1; day <= 9; day += 1) {
      activities.push(sleep(`2026-06-${pad(day)}T19:00`, `2026-06-${pad(day + 1)}T07:00`));
    }
    const running = sleep("2026-06-10T20:00", null, { timerState: "running" });
    const now = at("2026-06-11T10:00").getTime();

    const withRunning = buildTrends([...activities, running], { timeZone, now }).sleep.points;
    const without = buildTrends(activities, { timeZone, now }).sleep.points;

    expect(withRunning.map((point) => point.value)).not.toEqual(without.map((point) => point.value));
    const week = withRunning.find((point) => point.weekKey === "2026-06-08");
    const sameWeek = without.find((point) => point.weekKey === "2026-06-08");
    expect(week?.value ?? 0).toBeGreaterThan(sameWeek?.value ?? 0);
  });

  it("skips an entry whose timestamp cannot be read rather than failing the whole page", () => {
    const activities = [
      { ...feed("2026-06-01T08:00", 4, "bottle", "oz"), occurredAt: new Date("not a date") },
      ...Array.from({ length: 7 }, (_, index) => feed(`2026-06-0${index + 1}T09:00`, 4, "bottle", "oz"))
    ];

    expect(() => buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() })).not.toThrow();
  });

  it("survives a sleep whose end or length cannot be read", () => {
    const cases = [
      { ...sleep("2026-06-01T19:00", "2026-06-02T07:00"), endedAt: new Date("not a date") },
      { ...sleep("2026-06-01T19:00", null), timerState: "none", durationSeconds: Number.NaN },
      { ...sleep("2026-06-01T19:00", null), timerState: "none", durationSeconds: 1e18 }
    ];

    for (const broken of cases) {
      expect(() => buildTrends([broken], { timeZone, now: at("2026-06-10T12:00").getTime() })).not.toThrow();
    }
  });
  it("draws the line at two days, so a long night counts and a forgotten day does not", () => {
    // Pins the boundary itself. Without this, the limit could be widened to a month and every test
    // would still pass, because the forgotten-timer cases use spans far beyond any plausible limit.
    const pad = (value: number) => String(value).padStart(2, "0");
    const nights: ReturnType<typeof sleep>[] = [];
    for (let day = 1; day <= 9; day += 1) {
      nights.push(sleep(`2026-06-${pad(day)}T19:00`, `2026-06-${pad(day + 1)}T07:00`));
    }
    const now = at("2026-06-12T12:00").getTime();
    const baseline = buildTrends(nights, { timeZone, now }).sleep.points.map((point) => point.value);

    // 47 hours: inside the limit, so it must still be counted.
    const justInside = buildTrends([...nights, sleep("2026-06-10T13:00", null, { timerState: "running" })], { timeZone, now })
      .sleep.points.map((point) => point.value);
    // 49 hours: past the limit, so it must be left out entirely.
    const justOutside = buildTrends([...nights, sleep("2026-06-10T11:00", null, { timerState: "running" })], { timeZone, now })
      .sleep.points.map((point) => point.value);

    expect(justInside).not.toEqual(baseline);
    expect(justOutside).toEqual(baseline);
  });
  it("counts a day it had to set aside, so the caption cannot imply full coverage", () => {
    // A week logged on all seven days, three of which had a bottle with no amount. Reporting "4 of
    // 4 days" would read as complete coverage of a week where three days were thrown away.
    const activities = [];
    for (let day = 1; day <= 7; day += 1) {
      const date = `2026-06-0${day}`;
      for (let n = 0; n < 4; n += 1) activities.push(feed(`${date}T${String(6 + n * 2).padStart(2, "0")}:00`, 4, "bottle", "oz"));
      if (day > 4) activities.push(feed(`${date}T20:00`, null, "bottle", null));
    }

    const [week] = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).volume.points;

    expect(week.value).toBeCloseTo(16, 1);
    expect(week.daysCounted).toBe(4);
    expect(week.daysUnknown).toBe(3);
  });

  it("leaves no day unaccounted for in a week where every bottle was written down", () => {
    const activities = [];
    for (let day = 1; day <= 7; day += 1) {
      const date = `2026-06-0${day}`;
      for (let n = 0; n < 4; n += 1) activities.push(feed(`${date}T${String(6 + n * 2).padStart(2, "0")}:00`, 4, "bottle", "oz"));
    }

    const [week] = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).volume.points;

    expect(week.daysUnknown).toBe(0);
  });

  it("ignores a forgotten timer even when its end is unreadable rather than absent", () => {
    // The guard used to ask whether endedAt was absent. A row carrying an end that cannot be read is
    // just as unfinished, and asking the wrong question let it fill every day with 24 hours.
    const pad = (value: number) => String(value).padStart(2, "0");
    const activities: ReturnType<typeof sleep>[] = [
      { ...sleep("2026-04-01T20:00", null, { timerState: "running" }), endedAt: new Date("not a date") }
    ];
    for (let day = 1; day <= 7; day += 1) {
      activities.push(sleep(`2026-06-${pad(day)}T19:00`, `2026-06-${pad(day + 1)}T07:00`));
    }

    const trends = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() });
    const baseline = buildTrends(activities.slice(1), { timeZone, now: at("2026-06-10T12:00").getTime() });

    expect(trends.sleep.points.map((point) => point.value)).toEqual(baseline.sleep.points.map((point) => point.value));
    expect(trends.startKey).toBe(baseline.startKey);
  });

  it("drops a timer running for days, not only one running for weeks", () => {
    // Pins the limit from above as well as below: a five-day timer must go, or the limit could be
    // widened to a month and the forgotten-timer cases would all still pass.
    const pad = (value: number) => String(value).padStart(2, "0");
    const nights: ReturnType<typeof sleep>[] = [];
    for (let day = 1; day <= 9; day += 1) {
      nights.push(sleep(`2026-06-${pad(day)}T19:00`, `2026-06-${pad(day + 1)}T07:00`));
    }
    const now = at("2026-06-12T12:00").getTime();
    const baseline = buildTrends(nights, { timeZone, now }).sleep.points.map((point) => point.value);

    const fiveDays = buildTrends([...nights, sleep("2026-06-07T12:00", null, { timerState: "running" })], { timeZone, now })
      .sleep.points.map((point) => point.value);

    expect(fiveDays).toEqual(baseline);
  });

  it("judges a week by the bottles it could read, not by the ones that merely had a number", () => {
    // The share guard's numerator. Four days fully recorded in ounces, three recorded in a unit this
    // cannot convert: every bottle carries a number, so a guard counting numbers sees a complete
    // week and reports the four good days as though they spoke for all seven. Counting only what is
    // readable sees 16 bottles of 28 and declines. This shape is the one that separates the two.
    const activities = [];
    for (let day = 1; day <= 7; day += 1) {
      const date = `2026-06-0${day}`;
      for (let n = 0; n < 4; n += 1) {
        activities.push(feed(`${date}T${String(6 + n * 2).padStart(2, "0")}:00`, 4, "bottle", day <= 4 ? "oz" : "tbsp"));
      }
    }

    const [week] = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).volume.points;

    expect(week.value).toBeNull();
    expect(week.daysCounted).toBe(4);
    expect(week.daysUnknown).toBe(3);
  });
  it("blames a missing amount only on the day that had one, not on a thinly logged day", () => {
    // Two different reasons a day is not counted, in one week: five days well logged, one day a
    // sitter recorded a single bottle on, and one day whose bottle carried no amount. Counting the
    // sitter day as a missing amount would blame it for something it did not do - and "logged but
    // not counted" is already visible in the day counts without mislabelling why.
    const activities = [];
    for (let day = 1; day <= 5; day += 1) {
      const date = `2026-06-0${day}`;
      for (let n = 0; n < 8; n += 1) activities.push(feed(`${date}T${String(6 + n).padStart(2, "0")}:00`, 2, "bottle", "oz"));
    }
    activities.push(feed("2026-06-06T09:00", 2, "bottle", "oz"));
    for (let n = 0; n < 7; n += 1) activities.push(feed(`2026-06-07T${String(6 + n).padStart(2, "0")}:00`, 2, "bottle", "oz"));
    activities.push(feed("2026-06-07T20:00", null, "bottle", null));

    const [week] = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).volume.points;

    expect(week.daysCounted).toBe(5);
    expect(week.daysLogged).toBe(7);
    expect(week.daysUnknown).toBe(1);
  });
});
