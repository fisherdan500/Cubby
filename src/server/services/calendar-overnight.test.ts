/**
 * An overnight activity on the calendar.
 *
 * The log was fixed to show a sleep that crossed midnight on both days it touches. The calendar's
 * day sheet still filed every activity under the moment it was recorded, so tapping the morning in
 * the calendar showed nothing while the same day's log showed the sleep. Two views of one day
 * disagreeing is worse than the original bug.
 */
import { describe, expect, it } from "vitest";

import { calendarDayKeysForActivity } from "./calendar";

const zone = "America/New_York";

describe("which calendar days an activity belongs to", () => {
  it("files an ordinary activity under the day it happened", () => {
    const keys = calendarDayKeysForActivity(
      {
        occurredAt: new Date("2026-09-28T17:00:00.000Z"), // 1pm EDT
        startedAt: new Date("2026-09-28T17:00:00.000Z"),
        endedAt: new Date("2026-09-28T17:30:00.000Z")
      },
      zone
    );
    expect(keys).toEqual(["2026-09-28"]);
  });

  it("files a sleep that crossed midnight under both days", () => {
    const keys = calendarDayKeysForActivity(
      {
        occurredAt: new Date("2026-09-28T00:44:00.000Z"), // Sep 27 8:44pm EDT
        startedAt: new Date("2026-09-28T00:44:00.000Z"),
        endedAt: new Date("2026-09-28T12:30:00.000Z") // Sep 28 8:30am EDT
      },
      zone
    );
    expect(keys).toEqual(["2026-09-27", "2026-09-28"]);
  });

  it("files a still-running activity under the day it began only", () => {
    // It has no end yet, so it cannot be placed on a later day: the running timer reports it.
    const keys = calendarDayKeysForActivity(
      {
        occurredAt: new Date("2026-09-28T00:44:00.000Z"),
        startedAt: new Date("2026-09-28T00:44:00.000Z"),
        endedAt: null
      },
      zone
    );
    expect(keys).toEqual(["2026-09-27"]);
  });

  it("files an activity with no interval under its recorded day", () => {
    // A diaper change is a moment, and has no startedAt at all on older rows.
    const keys = calendarDayKeysForActivity(
      { occurredAt: new Date("2026-09-28T17:00:00.000Z"), startedAt: null, endedAt: null },
      zone
    );
    expect(keys).toEqual(["2026-09-28"]);
  });

  it("spans every day a long activity touches", () => {
    const keys = calendarDayKeysForActivity(
      {
        occurredAt: new Date("2026-09-27T23:00:00.000Z"), // Sep 27 7pm EDT
        startedAt: new Date("2026-09-27T23:00:00.000Z"),
        endedAt: new Date("2026-09-30T13:00:00.000Z") // Sep 30 9am EDT
      },
      zone
    );
    expect(keys).toEqual(["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"]);
  });

  it("keeps an activity ending exactly at midnight on the day it began", () => {
    // Half-open, matching the day window the log already uses.
    const keys = calendarDayKeysForActivity(
      {
        occurredAt: new Date("2026-09-28T02:00:00.000Z"), // Sep 27 10pm EDT
        startedAt: new Date("2026-09-28T02:00:00.000Z"),
        endedAt: new Date("2026-09-28T04:00:00.000Z") // Sep 28 00:00 EDT exactly
      },
      zone
    );
    expect(keys).toEqual(["2026-09-27"]);
  });
});
