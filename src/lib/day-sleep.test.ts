import { describe, expect, it } from "vitest";
import { dayAwakeSeconds, dayElapsedSeconds, daySleepSeconds, sleepInterval, type DaySleepRecord } from "@/lib/day-sleep";

const dayStart = new Date("2026-09-21T00:00:00.000Z");
const dayEnd = new Date("2026-09-22T00:00:00.000Z");
const nineAm = Date.parse("2026-09-21T09:00:00.000Z");
const dayOver = Date.parse("2026-09-23T00:00:00.000Z");

function sleep(overrides: Partial<DaySleepRecord> = {}): DaySleepRecord {
  return {
    occurredAt: "2026-09-21T13:00:00.000Z",
    startedAt: "2026-09-21T13:00:00.000Z",
    endedAt: "2026-09-21T14:30:00.000Z",
    durationSeconds: 5_400,
    timerState: "stopped",
    pausedAt: null,
    ...overrides
  };
}

describe("a sleep's stretch of wall clock", () => {
  it("runs from its start to its end", () => {
    expect(sleepInterval(sleep(), nineAm)).toEqual({
      start: Date.parse("2026-09-21T13:00:00.000Z"),
      end: Date.parse("2026-09-21T14:30:00.000Z")
    });
  });

  it("runs a still-running sleep up to now", () => {
    const running = sleep({
      occurredAt: "2026-09-21T08:00:00.000Z",
      startedAt: "2026-09-21T08:00:00.000Z",
      endedAt: null,
      durationSeconds: null,
      timerState: "running"
    });
    expect(sleepInterval(running, nineAm)?.end).toBe(nineAm);
  });

  it("stops a paused sleep at the moment it was paused", () => {
    const paused = sleep({
      startedAt: "2026-09-21T08:00:00.000Z",
      endedAt: null,
      durationSeconds: null,
      timerState: "paused",
      pausedAt: "2026-09-21T08:30:00.000Z"
    });
    expect(sleepInterval(paused, nineAm)?.end).toBe(Date.parse("2026-09-21T08:30:00.000Z"));
  });

  it("derives an end from the duration when a sleep was entered by hand", () => {
    const typed = sleep({ endedAt: null, timerState: "none", durationSeconds: 3_600 });
    expect(sleepInterval(typed, nineAm)?.end).toBe(Date.parse("2026-09-21T14:00:00.000Z"));
  });

  it("falls back to when it occurred if no start was kept", () => {
    const loose = sleep({ startedAt: null, endedAt: null, timerState: "none", durationSeconds: 600 });
    expect(sleepInterval(loose, nineAm)?.start).toBe(Date.parse("2026-09-21T13:00:00.000Z"));
  });

  it("has no stretch at all without a duration or an end", () => {
    expect(sleepInterval(sleep({ endedAt: null, durationSeconds: null, timerState: "none" }), nineAm)).toBeNull();
  });
});

describe("sleep inside a day", () => {
  it("counts a sleep that sits wholly inside it", () => {
    expect(daySleepSeconds([sleep()], dayStart, dayEnd, dayOver)).toEqual({ seconds: 5_400, count: 1 });
  });

  it("counts only the part of last night's sleep that fell after midnight", () => {
    // 23:00 to 07:00: the morning owns seven hours of it, and the evening before owns the other one.
    const overnight = sleep({
      occurredAt: "2026-09-20T23:00:00.000Z",
      startedAt: "2026-09-20T23:00:00.000Z",
      endedAt: "2026-09-21T07:00:00.000Z",
      durationSeconds: 28_800
    });

    expect(daySleepSeconds([overnight], dayStart, dayEnd, dayOver)).toEqual({ seconds: 25_200, count: 1 });
  });

  it("counts only the part of tonight's sleep that falls before midnight", () => {
    const intoTomorrow = sleep({
      occurredAt: "2026-09-21T23:00:00.000Z",
      startedAt: "2026-09-21T23:00:00.000Z",
      endedAt: "2026-09-22T07:00:00.000Z",
      durationSeconds: 28_800
    });

    expect(daySleepSeconds([intoTomorrow], dayStart, dayEnd, dayOver)).toEqual({ seconds: 3_600, count: 1 });
  });

  it("ignores a sleep that never touches the day", () => {
    const yesterday = sleep({
      occurredAt: "2026-09-19T13:00:00.000Z",
      startedAt: "2026-09-19T13:00:00.000Z",
      endedAt: "2026-09-19T14:00:00.000Z"
    });

    expect(daySleepSeconds([yesterday], dayStart, dayEnd, dayOver)).toEqual({ seconds: 0, count: 0 });
  });

  it("never counts more sleep than a paused nap actually recorded", () => {
    // Two hours on the clock, but half an hour of it was paused, so only 90 minutes were slept.
    const paused = sleep({
      startedAt: "2026-09-21T13:00:00.000Z",
      endedAt: "2026-09-21T15:00:00.000Z",
      durationSeconds: 5_400
    });

    expect(daySleepSeconds([paused], dayStart, dayEnd, dayOver).seconds).toBe(5_400);
  });

  it("adds up every sleep that touched the day", () => {
    const overnight = sleep({
      occurredAt: "2026-09-20T23:00:00.000Z",
      startedAt: "2026-09-20T23:00:00.000Z",
      endedAt: "2026-09-21T07:00:00.000Z",
      durationSeconds: 28_800
    });

    expect(daySleepSeconds([overnight, sleep()], dayStart, dayEnd, dayOver)).toEqual({
      seconds: 25_200 + 5_400,
      count: 2
    });
  });
});

describe("the day so far, and how much of it was awake", () => {
  it("measures a finished day end to end", () => {
    expect(dayElapsedSeconds(dayStart, dayEnd, dayOver)).toBe(86_400);
  });

  it("measures today only as far as now", () => {
    expect(dayElapsedSeconds(dayStart, dayEnd, nineAm)).toBe(32_400);
  });

  it("measures nothing for a day that has not started", () => {
    expect(dayElapsedSeconds(dayStart, dayEnd, Date.parse("2026-09-20T12:00:00.000Z"))).toBe(0);
  });

  it("measures a daylight-saving day as the length it really was", () => {
    // 2026-11-01 in New York runs 25 hours, and the window's own instants carry that.
    const longDayStart = new Date("2026-11-01T04:00:00.000Z");
    const longDayEnd = new Date("2026-11-02T05:00:00.000Z");

    expect(dayElapsedSeconds(longDayStart, longDayEnd, dayOver + 1e12)).toBe(90_000);
  });

  it("is the day so far less its sleep", () => {
    expect(dayAwakeSeconds(dayStart, dayEnd, nineAm, 25_200)).toBe(7_200);
  });

  it("never goes negative when the records say more sleep than the day holds", () => {
    expect(dayAwakeSeconds(dayStart, dayEnd, nineAm, 99_999)).toBe(0);
  });

  it("adds up with sleep to exactly the day so far", () => {
    const sleepSeconds = daySleepSeconds([sleep()], dayStart, dayEnd, dayOver).seconds;
    expect(sleepSeconds + dayAwakeSeconds(dayStart, dayEnd, dayOver, sleepSeconds)).toBe(86_400);
  });
});
