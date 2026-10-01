/**
 * Setting how long an activity lasted by saying when it ended.
 *
 * A sleep logged with a timer shows its length in minutes. To correct the time the baby actually
 * woke, a caregiver had to work out how many minutes that was from when she went down -- and for a
 * night sleep, across midnight, in their head. Saying "she woke at 7:20am" is the way a person
 * actually knows it.
 */
import { describe, expect, it } from "vitest";

import { endWallTimeToMinutes, minutesToEndWallTime } from "./wall-time";

describe("an activity's end as a time rather than a count of minutes", () => {
  it("turns an end time into the length it implies", () => {
    expect(endWallTimeToMinutes("2026-09-28T09:45", "2026-09-28T12:15")).toBe(150);
  });

  it("carries a night sleep across midnight", () => {
    // The case that made this necessary: 8:44pm to 8:30am is not arithmetic a tired parent should
    // be asked to do.
    expect(endWallTimeToMinutes("2026-09-27T20:44", "2026-09-28T08:30")).toBe(706);
  });

  it("gives the end time a length implies, for the picker's starting value", () => {
    expect(minutesToEndWallTime("2026-09-27T20:44", 706)).toBe("2026-09-28T08:30");
  });

  it("round-trips a length through an end time unchanged", () => {
    const start = "2026-09-27T20:44";
    for (const minutes of [1, 30, 150, 706, 1439, 2880]) {
      expect(endWallTimeToMinutes(start, minutesToEndWallTime(start, minutes))).toBe(minutes);
    }
  });

  it("refuses an end before the start, because an activity cannot end before it begins", () => {
    expect(endWallTimeToMinutes("2026-09-28T09:45", "2026-09-28T09:44")).toBeNull();
  });

  it("treats an end equal to the start as no length at all", () => {
    expect(endWallTimeToMinutes("2026-09-28T09:45", "2026-09-28T09:45")).toBe(0);
  });

  it("refuses a value that is not a wall time", () => {
    expect(endWallTimeToMinutes("2026-09-28T09:45", "")).toBeNull();
    expect(endWallTimeToMinutes("2026-09-28T09:45", "tomorrow")).toBeNull();
  });

  it("spans several days for an activity that ran that long", () => {
    expect(endWallTimeToMinutes("2026-09-27T20:00", "2026-09-29T08:00")).toBe(2160);
  });
});
