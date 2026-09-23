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

  it("marks legacy cross-day pauses unavailable instead of guessing which day owned them", () => {
    const legacyPaused = sleep({
      occurredAt: "2026-09-20T23:00:00.000Z",
      startedAt: "2026-09-20T23:00:00.000Z",
      endedAt: "2026-09-21T07:00:00.000Z",
      durationSeconds: 25_200,
      pausedSeconds: 3_600,
      pauseTrackingStartedAt: null
    });

    expect(daySleepSeconds([legacyPaused], dayStart, dayEnd, dayOver)).toEqual({
      seconds: null,
      count: 1,
      unavailableReason: "legacy_pause_allocation"
    });
  });

  it("marks a duration/envelope mismatch unavailable when no pause placement exists", () => {
    const importedMismatch = sleep({
      occurredAt: "2026-09-20T23:00:00.000Z",
      startedAt: "2026-09-20T23:00:00.000Z",
      endedAt: "2026-09-21T01:00:00.000Z",
      durationSeconds: 3_600,
      pausedSeconds: 0,
      pauseTrackingStartedAt: null
    });

    expect(daySleepSeconds([importedMismatch], dayStart, dayEnd, dayOver)).toEqual({
      seconds: null,
      count: 1,
      unavailableReason: "duration_position_unknown"
    });
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

  it("uses a legacy aggregate duration when the whole isolated sleep belongs to the day", () => {
    const paused = sleep({
      startedAt: "2026-09-21T13:00:00.000Z",
      endedAt: "2026-09-21T15:00:00.000Z",
      durationSeconds: 5_400
    });

    expect(daySleepSeconds([paused], dayStart, dayEnd, dayOver)).toEqual({ seconds: 5_400, count: 1 });
  });

  it("keeps a legacy aggregate unavailable when its unknown sleep position can overlap another sleep", () => {
    const paused = sleep({
      startedAt: "2026-09-21T13:00:00.000Z",
      endedAt: "2026-09-21T15:00:00.000Z",
      durationSeconds: 5_400
    });
    const overlapping = sleep({
      startedAt: "2026-09-21T14:00:00.000Z",
      endedAt: "2026-09-21T14:30:00.000Z",
      durationSeconds: 1_800
    });

    expect(daySleepSeconds([paused, overlapping], dayStart, dayEnd, dayOver)).toEqual({
      seconds: null,
      count: 2,
      unavailableReason: "duration_position_unknown"
    });
  });

  it("subtracts the exact part of a completed pause that overlaps the selected window", () => {
    const paused = sleep({
      occurredAt: "2026-09-21T00:00:00.000Z",
      startedAt: "2026-09-21T00:00:00.000Z",
      endedAt: "2026-09-21T03:00:00.000Z",
      durationSeconds: 7_200,
      pausedSeconds: 3_600,
      pauseTrackingStartedAt: "2026-09-21T00:00:00.000Z",
      pauseIntervals: [
        {
          startedAt: "2026-09-21T01:00:00.000Z",
          endedAt: "2026-09-21T02:00:00.000Z"
        }
      ]
    });

    const result = daySleepSeconds(
      [paused],
      new Date("2026-09-21T01:30:00.000Z"),
      new Date("2026-09-21T03:00:00.000Z"),
      dayOver
    );
    expect(result).toEqual({ seconds: 3_600, count: 1 });
  });

  it("subtracts earlier completed pauses from a timer that is running again", () => {
    const result = daySleepSeconds(
      [sleep({
        startedAt: "2026-09-21T08:00:00.000Z",
        endedAt: null,
        durationSeconds: null,
        timerState: "running",
        pausedSeconds: 3_600,
        pauseTrackingStartedAt: "2026-09-21T08:00:00.000Z",
        pauseIntervals: [{ startedAt: "2026-09-21T08:30:00.000Z", endedAt: "2026-09-21T09:30:00.000Z" }]
      })],
      new Date("2026-09-21T08:00:00.000Z"),
      new Date("2026-09-22T00:00:00.000Z"),
      new Date("2026-09-21T10:30:00.000Z").getTime()
    );

    expect(result).toEqual({ seconds: 5_400, count: 1 });
  });

  it("subtracts completed pauses before the current open pause", () => {
    const result = daySleepSeconds(
      [sleep({
        startedAt: "2026-09-21T08:00:00.000Z",
        endedAt: null,
        durationSeconds: null,
        timerState: "paused",
        pausedAt: "2026-09-21T10:00:00.000Z",
        pausedSeconds: 1_800,
        pauseTrackingStartedAt: "2026-09-21T08:00:00.000Z",
        pauseIntervals: [
          { startedAt: "2026-09-21T08:30:00.000Z", endedAt: "2026-09-21T09:00:00.000Z" },
          { startedAt: "2026-09-21T10:00:00.000Z", endedAt: null }
        ]
      })],
      new Date("2026-09-21T08:00:00.000Z"),
      new Date("2026-09-22T00:00:00.000Z"),
      new Date("2026-09-21T11:00:00.000Z").getTime()
    );

    expect(result).toEqual({ seconds: 5_400, count: 1 });
  });

  it("clips a precise pause that crosses midnight", () => {
    const result = daySleepSeconds(
      [sleep({
        startedAt: "2026-09-20T23:00:00.000Z",
        endedAt: "2026-09-21T02:00:00.000Z",
        durationSeconds: 7_200,
        timerState: "stopped",
        pausedSeconds: 3_600,
        pauseTrackingStartedAt: "2026-09-20T23:00:00.000Z",
        pauseIntervals: [{ startedAt: "2026-09-20T23:30:00.000Z", endedAt: "2026-09-21T00:30:00.000Z" }]
      })],
      dayStart,
      dayEnd,
      dayOver
    );

    expect(result).toEqual({ seconds: 5_400, count: 1 });
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

  it("counts overlapping sleep intervals only once", () => {
    const first = sleep({
      occurredAt: "2026-09-21T00:00:00.000Z",
      startedAt: "2026-09-21T00:00:00.000Z",
      endedAt: "2026-09-21T02:00:00.000Z",
      durationSeconds: 7_200
    });
    const second = sleep({
      occurredAt: "2026-09-21T01:00:00.000Z",
      startedAt: "2026-09-21T01:00:00.000Z",
      endedAt: "2026-09-21T03:00:00.000Z",
      durationSeconds: 7_200
    });

    expect(daySleepSeconds([first, second], dayStart, dayEnd, dayOver)).toEqual({
      seconds: 10_800,
      count: 2
    });
  });

  it("uses exact pauses across a later tracking boundary when the legacy baseline is zero", () => {
    const tracked = sleep({
      occurredAt: "2026-09-21T10:00:00.000Z",
      startedAt: "2026-09-21T10:00:00.000Z",
      endedAt: "2026-09-21T11:00:00.000Z",
      durationSeconds: 3_000,
      pausedSeconds: 600,
      pauseTrackingStartedAt: "2026-09-21T10:30:00.000Z",
      pauseTrackingBaselineSeconds: 0,
      pauseIntervals: [{
        startedAt: new Date("2026-09-21T10:40:00.000Z"),
        endedAt: new Date("2026-09-21T10:50:00.000Z")
      }]
    });
    const overlapping = sleep({
      occurredAt: "2026-09-21T10:45:00.000Z",
      startedAt: "2026-09-21T10:45:00.000Z",
      endedAt: "2026-09-21T11:15:00.000Z",
      durationSeconds: 1_800
    });

    expect(daySleepSeconds([tracked, overlapping], dayStart, dayEnd, dayOver)).toEqual({
      seconds: 4_200,
      count: 2
    });
  });

  it("does not count a future-only sleep in today's elapsed totals", () => {
    const future = sleep({
      occurredAt: "2026-09-21T10:00:00.000Z",
      startedAt: "2026-09-21T10:00:00.000Z",
      endedAt: "2026-09-21T12:00:00.000Z",
      durationSeconds: 7_200
    });

    expect(daySleepSeconds([future], dayStart, dayEnd, nineAm)).toEqual({ seconds: 0, count: 0 });
  });

  it("counts a sleep crossing now only through the elapsed instant", () => {
    const crossingNow = sleep({
      occurredAt: "2026-09-21T08:00:00.000Z",
      startedAt: "2026-09-21T08:00:00.000Z",
      endedAt: "2026-09-21T10:00:00.000Z",
      durationSeconds: 7_200
    });

    expect(daySleepSeconds([crossingNow], dayStart, dayEnd, nineAm)).toEqual({ seconds: 3_600, count: 1 });
  });

  it("uses the same absolute-second grid as persisted timer and pause durations", () => {
    const fractional = sleep({
      occurredAt: "2026-09-21T10:00:00.400Z",
      startedAt: "2026-09-21T10:00:00.400Z",
      endedAt: "2026-09-21T10:00:10.800Z",
      durationSeconds: 10,
      pausedSeconds: 1,
      pauseTrackingStartedAt: "2026-09-21T10:00:00.400Z",
      pauseTrackingBaselineSeconds: 0,
      pauseIntervals: [{
        startedAt: "2026-09-21T10:00:05.000Z",
        endedAt: "2026-09-21T10:00:05.600Z"
      }]
    });

    expect(daySleepSeconds([fractional], dayStart, dayEnd, dayOver)).toEqual({ seconds: 10, count: 1 });
  });

  it("preserves predecessor-rounded aggregate duration when the full legacy envelope is isolated", () => {
    const predecessorLonger = sleep({
      occurredAt: "2026-09-21T10:00:00.600Z",
      startedAt: "2026-09-21T10:00:00.600Z",
      endedAt: "2026-09-21T10:00:10.400Z",
      durationSeconds: 10,
      pauseTrackingStartedAt: null
    });
    const predecessorShorter = sleep({
      occurredAt: "2026-09-21T11:00:00.400Z",
      startedAt: "2026-09-21T11:00:00.400Z",
      endedAt: "2026-09-21T11:00:10.600Z",
      durationSeconds: 10,
      pauseTrackingStartedAt: null
    });

    expect(daySleepSeconds([predecessorLonger], dayStart, dayEnd, dayOver)).toEqual({ seconds: 10, count: 1 });
    expect(daySleepSeconds([predecessorShorter], dayStart, dayEnd, dayOver)).toEqual({ seconds: 10, count: 1 });
  });

  it("reports predecessor-rounded placement unavailable when another sleep overlaps its uncertain boundary", () => {
    const predecessor = sleep({
      occurredAt: "2026-09-21T10:00:00.400Z",
      startedAt: "2026-09-21T10:00:00.400Z",
      endedAt: "2026-09-21T10:00:10.600Z",
      durationSeconds: 10,
      pauseTrackingStartedAt: null
    });
    const boundarySleep = sleep({
      occurredAt: "2026-09-21T10:00:10.400Z",
      startedAt: "2026-09-21T10:00:10.400Z",
      endedAt: "2026-09-21T10:00:11.400Z",
      durationSeconds: 1
    });

    expect(daySleepSeconds([predecessor, boundarySleep], dayStart, dayEnd, dayOver)).toEqual({
      seconds: null,
      count: 2,
      unavailableReason: "duration_position_unknown"
    });
  });

  it("reports a predecessor-rounded extra second unavailable beside an adjacent sleep", () => {
    const predecessorLonger = sleep({
      occurredAt: "2026-09-21T10:00:00.600Z",
      startedAt: "2026-09-21T10:00:00.600Z",
      endedAt: "2026-09-21T10:00:10.400Z",
      durationSeconds: 10,
      pauseTrackingStartedAt: null
    });
    const adjacentSleep = sleep({
      occurredAt: "2026-09-21T10:00:10.400Z",
      startedAt: "2026-09-21T10:00:10.400Z",
      endedAt: "2026-09-21T10:00:11.400Z",
      durationSeconds: 1
    });

    expect(daySleepSeconds([predecessorLonger, adjacentSleep], dayStart, dayEnd, dayOver)).toEqual({
      seconds: null,
      count: 2,
      unavailableReason: "duration_position_unknown"
    });
  });

  it("reports predecessor-rounded boundary uncertainty unavailable when it enters the day", () => {
    const entering = sleep({
      occurredAt: "2026-09-20T23:59:59.600Z",
      startedAt: "2026-09-20T23:59:59.600Z",
      endedAt: "2026-09-21T00:00:10.400Z",
      durationSeconds: 11,
      pauseTrackingStartedAt: null
    });

    expect(daySleepSeconds([entering], dayStart, dayEnd, dayOver)).toEqual({
      seconds: null,
      count: 1,
      unavailableReason: "duration_position_unknown"
    });
  });

  it("reports predecessor-rounded boundary uncertainty unavailable when it leaves the day", () => {
    const leaving = sleep({
      occurredAt: "2026-09-21T23:59:49.600Z",
      startedAt: "2026-09-21T23:59:49.600Z",
      endedAt: "2026-09-22T00:00:00.400Z",
      durationSeconds: 11,
      pauseTrackingStartedAt: null
    });

    expect(daySleepSeconds([leaving], dayStart, dayEnd, dayOver)).toEqual({
      seconds: null,
      count: 1,
      unavailableReason: "duration_position_unknown"
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
    expect(sleepSeconds).not.toBeNull();
    if (sleepSeconds === null) throw new Error("expected exact sleep");
    expect(sleepSeconds + dayAwakeSeconds(dayStart, dayEnd, dayOver, sleepSeconds)).toBe(86_400);
  });
});
