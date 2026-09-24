import { describe, expect, it } from "vitest";
import { activeTimerActionLabel, activeTimerElapsedSeconds, formatTimerElapsed, timerElapsedSpoken } from "@/lib/active-timer";

const startedAt = "2026-09-21T10:00:00.000Z";
const now = Date.parse("2026-09-21T11:12:04.000Z");

describe("active timer elapsed", () => {
  it("measures a running timer to now, less the pauses already taken", () => {
    expect(activeTimerElapsedSeconds({ timerState: "running", startedAt, pausedAt: null, pausedSeconds: 0 }, now))
      .toBe(4_324);
    expect(activeTimerElapsedSeconds({ timerState: "running", startedAt, pausedAt: null, pausedSeconds: 300 }, now))
      .toBe(4_024);
  });

  it("freezes a paused timer at the moment it was paused", () => {
    const paused = {
      timerState: "paused",
      startedAt,
      pausedAt: "2026-09-21T10:30:00.000Z",
      pausedSeconds: 0
    };

    // The same value however much later it is read, which is what stops the digits moving on screen.
    expect(activeTimerElapsedSeconds(paused, now)).toBe(1_800);
    expect(activeTimerElapsedSeconds(paused, now + 600_000)).toBe(1_800);
  });

  it("matches what stopping the timer would save as its duration", () => {
    // stopTimer writes max(0, wall - pausedSeconds); the screen must not promise a different number.
    const timer = { timerState: "running", startedAt, pausedAt: null, pausedSeconds: 900 };
    const wallSeconds = Math.round((now - Date.parse(startedAt)) / 1_000);

    expect(activeTimerElapsedSeconds(timer, now)).toBe(Math.max(0, wallSeconds - 900));
  });

  it("matches canonical stop rounding at fractional absolute-second boundaries", () => {
    expect(activeTimerElapsedSeconds({
      timerState: "running",
      startedAt: "1970-01-01T00:00:00.600Z",
      pausedAt: null,
      pausedSeconds: 0
    }, Date.parse("1970-01-01T00:00:10.400Z"))).toBe(9);
  });

  it("never reports negative time from a clock skew or an overlong pause", () => {
    expect(activeTimerElapsedSeconds({ timerState: "running", startedAt, pausedAt: null, pausedSeconds: 99_999 }, now))
      .toBe(0);
    expect(activeTimerElapsedSeconds({ timerState: "running", startedAt, pausedAt: null, pausedSeconds: 0 }, Date.parse(startedAt) - 60_000))
      .toBe(0);
  });

  it("reports nothing for a timer with no start or an unreadable one", () => {
    expect(activeTimerElapsedSeconds({ timerState: "running", startedAt: null, pausedAt: null, pausedSeconds: 0 }, now)).toBe(0);
    expect(activeTimerElapsedSeconds({ timerState: "running", startedAt: "not-a-date", pausedAt: null, pausedSeconds: 0 }, now)).toBe(0);
  });

  it("falls back to now when a paused timer has lost its pause instant", () => {
    expect(activeTimerElapsedSeconds({ timerState: "paused", startedAt, pausedAt: null, pausedSeconds: 0 }, now)).toBe(4_324);
  });
});

describe("timer elapsed display", () => {
  it("shows seconds under an hour and hours beyond it", () => {
    expect(formatTimerElapsed(0)).toBe("0:00");
    expect(formatTimerElapsed(42)).toBe("0:42");
    expect(formatTimerElapsed(724)).toBe("12:04");
    expect(formatTimerElapsed(3_599)).toBe("59:59");
    expect(formatTimerElapsed(3_600)).toBe("1:00:00");
    expect(formatTimerElapsed(4_324)).toBe("1:12:04");
  });

  it("stays readable for a negative or fractional input", () => {
    expect(formatTimerElapsed(-5)).toBe("0:00");
    expect(formatTimerElapsed(90.9)).toBe("1:30");
  });

  it("speaks the duration in words, without the seconds a live region would repeat", () => {
    expect(timerElapsedSpoken(4_324)).toBe("1 hour 12 minutes");
    expect(timerElapsedSpoken(7_320)).toBe("2 hours 2 minutes");
    expect(timerElapsedSpoken(60)).toBe("1 minute");
    expect(timerElapsedSpoken(42)).toBe("0 minutes");
  });
});

describe("active timer action labels", () => {
  it("numbers only duplicate timer types for the same baby", () => {
    const timers = [
      { id: "a-1", babyId: "baby-a", type: "feeding" },
      { id: "b-1", babyId: "baby-b", type: "feeding" },
      { id: "a-2", babyId: "baby-a", type: "feeding" },
      { id: "a-sleep", babyId: "baby-a", type: "sleep" }
    ];

    expect(activeTimerActionLabel("Stop", "Avery", "Feeding", timers[0], timers))
      .toBe("Stop Avery's feeding timer 1 of 2");
    expect(activeTimerActionLabel("Stop", "Blake", "Feeding", timers[1], timers))
      .toBe("Stop Blake's feeding timer");
    expect(activeTimerActionLabel("Pause", "Avery", "Feeding", timers[2], timers))
      .toBe("Pause Avery's feeding timer 2 of 2");
  });
});
