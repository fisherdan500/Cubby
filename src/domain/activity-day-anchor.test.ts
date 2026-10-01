/**
 * Which moment an activity is filed under on a given day.
 *
 * A sleep that runs from 8pm to 8am belongs on both days, and on each of them the family is asking
 * a different question. On the evening it began: "when did she go down?" On the morning it ended:
 * "when did she wake?" So the entry is anchored to the moment it touches the day being viewed --
 * its start if it started that day, otherwise its end.
 */
import { describe, expect, it } from "vitest";

import { activityDayAnchor } from "./activity";

// A day in a zone that is not UTC, so a bug that anchors in the host zone cannot pass.
const zone = "America/New_York";
const dayStart = new Date("2026-09-28T04:00:00.000Z"); // Sep 28 00:00 EDT
const dayEnd = new Date("2026-09-29T04:00:00.000Z"); // Sep 29 00:00 EDT

describe("what moment an activity is filed under on a day", () => {
  it("anchors an entry that starts and ends inside the day to its start", () => {
    // Sprout files a 9:45am-12:15pm nap under Morning, not Afternoon.
    const anchor = activityDayAnchor(
      {
        startedAt: new Date("2026-09-28T13:45:00.000Z"), // 9:45am EDT
        endedAt: new Date("2026-09-28T16:15:00.000Z") // 12:15pm EDT
      },
      { start: dayStart, end: dayEnd }
    );
    expect(anchor).toEqual(new Date("2026-09-28T13:45:00.000Z"));
  });

  it("anchors an entry that began on an earlier day to its end", () => {
    // The overnight sleep, seen from the morning it ended: the family wants the wake-up time.
    const anchor = activityDayAnchor(
      {
        startedAt: new Date("2026-09-28T00:44:00.000Z"), // Sep 27 8:44pm EDT
        endedAt: new Date("2026-09-28T12:30:00.000Z") // Sep 28 8:30am EDT
      },
      { start: dayStart, end: dayEnd }
    );
    expect(anchor).toEqual(new Date("2026-09-28T12:30:00.000Z"));
  });

  it("anchors an entry that runs past midnight to its start on the day it began", () => {
    // The same sleep, seen from the evening it began.
    const anchor = activityDayAnchor(
      {
        startedAt: new Date("2026-09-28T00:44:00.000Z"),
        endedAt: new Date("2026-09-28T12:30:00.000Z")
      },
      { start: new Date("2026-09-27T04:00:00.000Z"), end: dayStart }
    );
    expect(anchor).toEqual(new Date("2026-09-28T00:44:00.000Z"));
  });

  it("gives a still-running entry no anchor on a later day", () => {
    // A sleep still in progress has no end, so it cannot be placed on today: the running timer on
    // the button is what says the baby is asleep right now.
    const anchor = activityDayAnchor(
      { startedAt: new Date("2026-09-28T00:44:00.000Z"), endedAt: null },
      { start: dayStart, end: dayEnd }
    );
    expect(anchor).toBeNull();
  });

  it("still anchors a running entry on the day it began", () => {
    const anchor = activityDayAnchor(
      { startedAt: new Date("2026-09-28T00:44:00.000Z"), endedAt: null },
      { start: new Date("2026-09-27T04:00:00.000Z"), end: dayStart }
    );
    expect(anchor).toEqual(new Date("2026-09-28T00:44:00.000Z"));
  });

  it("gives no anchor to an entry that does not touch the day at all", () => {
    const anchor = activityDayAnchor(
      {
        startedAt: new Date("2026-09-20T13:00:00.000Z"),
        endedAt: new Date("2026-09-20T14:00:00.000Z")
      },
      { start: dayStart, end: dayEnd }
    );
    expect(anchor).toBeNull();
  });

  it("anchors an instant entry with no end to its start", () => {
    // Most activities are a moment, not an interval: a diaper change has no end at all.
    const anchor = activityDayAnchor(
      { startedAt: new Date("2026-09-28T14:00:00.000Z"), endedAt: null },
      { start: dayStart, end: dayEnd }
    );
    expect(anchor).toEqual(new Date("2026-09-28T14:00:00.000Z"));
  });

  it("keeps an entry ending exactly at midnight on the day it began", () => {
    // The boundary is half-open, matching the day window the query already uses: an entry ending at
    // exactly 00:00 belongs to the day that is closing, not the one opening.
    const endedAtMidnight = {
      startedAt: new Date("2026-09-28T02:00:00.000Z"),
      endedAt: dayStart
    };
    expect(activityDayAnchor(endedAtMidnight, { start: dayStart, end: dayEnd })).toBeNull();
    expect(
      activityDayAnchor(endedAtMidnight, { start: new Date("2026-09-27T04:00:00.000Z"), end: dayStart })
    ).toEqual(new Date("2026-09-28T02:00:00.000Z"));
  });

  it("anchors an entry starting exactly at midnight to that start", () => {
    const anchor = activityDayAnchor(
      { startedAt: dayStart, endedAt: new Date("2026-09-28T06:00:00.000Z") },
      { start: dayStart, end: dayEnd }
    );
    expect(anchor).toEqual(dayStart);
  });
});
