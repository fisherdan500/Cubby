import { describe, expect, it } from "vitest";
import { buildObservedRoutine, ROUTINE_MIN_DAYS, type RoutineEvent } from "@/lib/observed-routine";
import { addDaysToDateKey, zonedDateTimeToDate } from "@/lib/timezone";

const timeZone = "America/New_York";
const week = { startKey: "2026-09-14", endKey: "2026-09-20", days: 7 };

const at = (key: string, time: string) => zonedDateTimeToDate(`${key}T${time}`, timeZone);
const sleep = (startKey: string, start: string, endKey: string | null, end: string | null): RoutineEvent => ({
  type: "sleep",
  start: at(startKey, start),
  end: endKey && end ? at(endKey, end) : null
});
const event = (type: string, key: string, time: string): RoutineEvent => ({ type, start: at(key, time), end: null });

/**
 * One ordinary day: the night that ends this morning, naps, day feeds, a night feed after bedtime and
 * the start of tonight's sleep, which ends on the next day's morning.
 */
function day(key: string, options: { wake?: string; naps?: Array<[string, string]>; feeds?: string[]; bedtime?: string; nightFeed?: string; bath?: string } = {}) {
  const next = addDaysToDateKey(key, 1);
  const events: RoutineEvent[] = [];
  const bedtime = options.bedtime ?? "19:15";
  const nextWake = options.wake ?? "06:30";
  for (const [start, end] of options.naps ?? [["09:30", "10:40"], ["13:30", "15:15"]]) events.push(sleep(key, start, key, end));
  for (const time of options.feeds ?? ["06:40", "09:50", "13:00", "16:10", "18:50"]) events.push(event("feeding", key, time));
  events.push(sleep(key, bedtime, next, nextWake));
  events.push(event("feeding", next, options.nightFeed ?? "02:10"));
  if (options.bath) events.push(event("bath", key, options.bath));
  return events;
}

/** The night before the window, so the first day in it has a known wake time. */
const nightBefore = [sleep("2026-09-13", "19:15", "2026-09-14", "06:30")];

function regularWeek(overrides: Record<string, Parameters<typeof day>[1]> = {}) {
  const events = [...nightBefore];
  for (let offset = 0; offset < 7; offset += 1) {
    const key = addDaysToDateKey(week.startKey, offset);
    events.push(...day(key, overrides[key]));
  }
  return events;
}

describe("buildObservedRoutine", () => {
  it("reads a regular week as wake, naps, feeds and bedtime at the times they actually happen", () => {
    const routine = buildObservedRoutine(regularWeek(), week, timeZone);

    expect(routine.enoughData).toBe(true);
    expect(routine.wake).toMatchObject({ time: "6:30 AM", days: 7 });
    expect(routine.bedtime).toMatchObject({ time: "7:15 PM", days: 7 });
    expect(routine.naps).toMatchObject({ usualCount: 2, daysWithUsualCount: 7 });
    expect(routine.naps?.slots.map(({ time, duration }) => ({ time, duration }))).toEqual([
      { time: "9:30 AM", duration: "1h 10m" },
      { time: "1:30 PM", duration: "1h 45m" }
    ]);
    expect(routine.night).toMatchObject({ duration: "11h 15m" });
    // The typical gap, not the mean: the shorter gap before bedtime does not drag every gap down.
    expect(routine.feeds).toMatchObject({ usualCount: 5, interval: "3h 10m", nightFeeds: { perNight: 1 } });
  });

  it("lays the day out in order from waking to bedtime, as a schedule someone else could follow", () => {
    const routine = buildObservedRoutine(regularWeek(), week, timeZone);

    expect(routine.timeline.map(({ label, slot }) => `${slot.time} ${label}`)).toEqual([
      "6:30 AM Wake up",
      "6:40 AM Feed",
      "9:30 AM Nap 1",
      "9:50 AM Feed",
      "1:00 PM Feed",
      "1:30 PM Nap 2",
      "4:10 PM Feed",
      "6:50 PM Feed",
      "7:15 PM Bedtime"
    ]);
  });

  it("is not thrown off by one day with an extra nap", () => {
    // Under the old rule the third day's 11:45 catnap became "the second sleep", and every later
    // average blended unrelated sleeps together.
    const routine = buildObservedRoutine(
      regularWeek({ "2026-09-16": { naps: [["09:30", "10:40"], ["11:45", "12:05"], ["13:30", "15:15"]] } }),
      week,
      timeZone
    );

    expect(routine.naps).toMatchObject({ usualCount: 2, daysWithUsualCount: 6, daysCounted: 7 });
    expect(routine.naps?.slots.map((slot) => slot.time)).toEqual(["9:30 AM", "1:30 PM"]);
  });

  it("says how much a time varies rather than hiding it behind an average", () => {
    const bedtimes = ["18:45", "19:45", "18:45", "19:45", "18:45", "19:45", "19:15"];
    const routine = buildObservedRoutine(
      regularWeek(Object.fromEntries(bedtimes.map((bedtime, offset) => [addDaysToDateKey(week.startKey, offset), { bedtime }]))),
      week,
      timeZone
    );

    expect(routine.bedtime).toMatchObject({ time: "7:15 PM", spreadMinutes: 25 });
  });

  it("keeps a late bedtime that crosses midnight as bedtime, and the morning after as that night's wake", () => {
    const routine = buildObservedRoutine(
      regularWeek(Object.fromEntries(Array.from({ length: 7 }, (_, offset) => [addDaysToDateKey(week.startKey, offset), { bedtime: "23:30", nightFeed: "03:00" }]))),
      week,
      timeZone
    );

    expect(routine.bedtime).toMatchObject({ time: "11:30 PM" });
    expect(routine.wake).toMatchObject({ time: "6:30 AM" });
    expect(routine.night).toMatchObject({ duration: "7h" });
  });

  it("offers no schedule until there are enough days to see one", () => {
    const events = [...day("2026-09-14"), ...day("2026-09-15")];
    const routine = buildObservedRoutine(events, week, timeZone);

    expect(ROUTINE_MIN_DAYS).toBe(3);
    expect(routine.enoughData).toBe(false);
    expect(routine.wake).toBeNull();
    expect(routine.naps).toBeNull();
    expect(routine.timeline).toEqual([]);
  });

  it("still gives feed times when sleep is not being logged", () => {
    const events: RoutineEvent[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      const key = addDaysToDateKey(week.startKey, offset);
      for (const time of ["07:00", "10:00", "13:00", "16:00", "19:00"]) events.push(event("feeding", key, time));
    }
    const routine = buildObservedRoutine(events, week, timeZone);

    expect(routine.wake).toBeNull();
    expect(routine.naps).toBeNull();
    expect(routine.feeds).toMatchObject({ usualCount: 5, interval: "3h", nightFeeds: null });
    expect(routine.feeds?.slots.map((slot) => slot.time)).toEqual(["7:00 AM", "10:00 AM", "1:00 PM", "4:00 PM", "7:00 PM"]);
  });

  it("includes other regular activities with how many days they happen on", () => {
    const bathDays = ["2026-09-14", "2026-09-15", "2026-09-17", "2026-09-18", "2026-09-20"];
    const routine = buildObservedRoutine(
      regularWeek(Object.fromEntries(bathDays.map((key) => [key, { bath: "18:30" }]))),
      week,
      timeZone
    );

    expect(routine.others).toEqual([
      expect.objectContaining({ type: "bath", daysWithAny: 5, usualCount: 1, slots: [expect.objectContaining({ time: "6:30 PM" })] })
    ]);
    expect(routine.timeline.find((entry) => entry.kind === "bath")).toMatchObject({ label: "Bath" });
  });

  it("leaves out a nap time it cannot pin down when the number of naps changes day to day", () => {
    const naps: Array<Array<[string, string]>> = [
      [["09:30", "10:40"]],
      [["09:30", "10:40"], ["13:30", "15:15"]],
      [["09:30", "10:40"], ["12:00", "12:30"], ["15:00", "15:40"]],
      [["10:00", "11:00"]],
      [["09:30", "10:40"], ["13:30", "15:15"]],
      [["09:30", "10:40"], ["12:00", "12:30"], ["15:00", "15:40"]],
      [["08:45", "09:15"], ["11:00", "12:00"], ["14:00", "14:30"], ["16:30", "16:50"]]
    ];
    const routine = buildObservedRoutine(
      regularWeek(Object.fromEntries(naps.map((list, offset) => [addDaysToDateKey(week.startKey, offset), { naps: list }]))),
      week,
      timeZone
    );

    expect(routine.naps).toMatchObject({ minCount: 1, maxCount: 4, slots: [] });
    expect(routine.timeline.some((entry) => entry.kind === "nap")).toBe(false);
  });

  it("counts a running sleep toward bedtime but not toward a wake time it has not reached", () => {
    const events = regularWeek();
    const lastNight = events.findIndex((item) => item.type === "sleep" && item.start.getTime() === at("2026-09-20", "19:15").getTime());
    events[lastNight] = sleep("2026-09-20", "19:15", null, null);
    const routine = buildObservedRoutine(events, week, timeZone);

    expect(routine.bedtime).toMatchObject({ days: 7 });
    expect(routine.wake).toMatchObject({ days: 7 });
  });
});
