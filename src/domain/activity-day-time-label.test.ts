/**
 * How an activity's time reads on a day's log.
 *
 * Most entries are a single moment and read as one time. An activity that crosses midnight has to
 * say more: on the morning it ended, "8:30 AM" alone would be a lie about when it happened, so it
 * carries both ends with dates attached, the way a family would say it out loud.
 */
import { describe, expect, it } from "vitest";

import { activityDayTimeLabel, activityTimeLabel } from "./activity";

const zone = "America/New_York";
const dayStart = new Date("2026-09-28T04:00:00.000Z"); // Sep 28 00:00 EDT
const dayEnd = new Date("2026-09-29T04:00:00.000Z");
const day = { start: dayStart, end: dayEnd };

describe("how an activity's time reads on a day", () => {
  it("reads as a single time when the activity is a moment", () => {
    const label = activityDayTimeLabel(
      { startedAt: new Date("2026-09-28T14:00:00.000Z"), endedAt: null },
      day,
      zone
    );
    expect(label).toEqual({ text: "10:00 AM", spansDays: false });
  });

  it("reads as a plain range when the activity starts and ends on the same day", () => {
    // No dates: they would be noise on a nap that obviously happened today.
    const label = activityDayTimeLabel(
      {
        startedAt: new Date("2026-09-28T13:45:00.000Z"), // 9:45am
        endedAt: new Date("2026-09-28T16:15:00.000Z") // 12:15pm
      },
      day,
      zone
    );
    expect(label).toEqual({ text: "9:45 AM - 12:15 PM", spansDays: false });
  });

  it("carries both dates when the activity crosses midnight", () => {
    // Exactly what Sprout shows, because without the dates the entry is unreadable.
    const label = activityDayTimeLabel(
      {
        startedAt: new Date("2026-09-28T00:44:00.000Z"), // Sep 27 8:44pm
        endedAt: new Date("2026-09-28T12:30:00.000Z") // Sep 28 8:30am
      },
      day,
      zone
    );
    expect(label).toEqual({ text: "Sep 27 8:44 PM - Sep 28 8:30 AM", spansDays: true });
  });

  it("reads the same on both days the activity appears on", () => {
    // The row says the same thing whichever day you found it from; only its position changes.
    const overnight = {
      startedAt: new Date("2026-09-28T00:44:00.000Z"),
      endedAt: new Date("2026-09-28T12:30:00.000Z")
    };
    const onTheEveningItBegan = activityDayTimeLabel(
      overnight,
      { start: new Date("2026-09-27T04:00:00.000Z"), end: dayStart },
      zone
    );
    expect(onTheEveningItBegan).toEqual(activityDayTimeLabel(overnight, day, zone));
  });

  it("shows a running activity as open-ended", () => {
    const label = activityDayTimeLabel(
      { startedAt: new Date("2026-09-28T13:45:00.000Z"), endedAt: null, running: true },
      day,
      zone
    );
    expect(label).toEqual({ text: "9:45 AM - now", spansDays: false });
  });

  it("reads in the household's zone, not the host's", () => {
    const label = activityDayTimeLabel(
      { startedAt: new Date("2026-09-28T14:00:00.000Z"), endedAt: null },
      day,
      "Asia/Tokyo"
    );
    expect(label.text).toBe("11:00 PM");
  });
  it("reads each household in its own zone, however many have been asked for", () => {
    // The formatters behind these labels are kept between calls, so the zone has to be part of what
    // is kept: the same instant is a different time of day in each household.
    const instant = new Date("2026-09-28T14:00:00.000Z");
    expect(activityTimeLabel(instant, "America/New_York")).toBe("10:00 AM");
    expect(activityTimeLabel(instant, "Asia/Tokyo")).toBe("11:00 PM");
    expect(activityTimeLabel(instant, "Europe/London")).toBe("3:00 PM");
    // Asked again after all three are remembered, in a different order.
    expect(activityTimeLabel(instant, "Asia/Tokyo")).toBe("11:00 PM");
    expect(activityTimeLabel(instant, "America/New_York")).toBe("10:00 AM");
  });

  it("keeps the three label shapes apart", () => {
    // A plain time, a time carrying a date, and the internal day comparison are three different
    // shapes. If a kept formatter were shared between them, a moment would read as "Sep 28, 10:00 AM"
    // or an overnight would lose its dates - and the day comparison would stop detecting midnight.
    const sameDay = activityDayTimeLabel(
      { startedAt: new Date("2026-09-28T14:00:00.000Z"), endedAt: new Date("2026-09-28T15:30:00.000Z") },
      day,
      zone
    );
    expect(sameDay).toEqual({ text: "10:00 AM - 11:30 AM", spansDays: false });

    const overnight = activityDayTimeLabel(
      { startedAt: new Date("2026-09-28T23:00:00.000Z"), endedAt: new Date("2026-09-29T11:00:00.000Z") },
      day,
      zone
    );
    expect(overnight).toEqual({ text: "Sep 28 7:00 PM - Sep 29 7:00 AM", spansDays: true });

    // And a plain time again afterwards, which would be wrong if the dated shape had been kept for it.
    expect(activityTimeLabel(new Date("2026-09-28T14:00:00.000Z"), zone)).toBe("10:00 AM");
  });

  it("still detects midnight in a zone asked about after another one", () => {
    // The day comparison is what decides whether dates appear. It is zone-sensitive: this activity
    // crosses midnight in New York but not in Tokyo, where both ends fall on the 29th.
    const crossesInNewYork = { startedAt: new Date("2026-09-28T23:00:00.000Z"), endedAt: new Date("2026-09-29T11:00:00.000Z") };
    expect(activityDayTimeLabel(crossesInNewYork, day, "Asia/Tokyo").spansDays).toBe(false);
    expect(activityDayTimeLabel(crossesInNewYork, day, "America/New_York").spansDays).toBe(true);
    // Reversed, so neither answer can be the one left over from the other.
    expect(activityDayTimeLabel(crossesInNewYork, day, "America/New_York").spansDays).toBe(true);
    expect(activityDayTimeLabel(crossesInNewYork, day, "Asia/Tokyo").spansDays).toBe(false);
  });
  it("tells a year apart from the same day", () => {
    // The day comparison decides whether dates appear at all, and it has to include the year: an
    // entry left running since last year is not "the same day" as today. A timer someone forgot to
    // stop is exactly how this arises.
    const yearApart = {
      startedAt: new Date("2026-06-15T18:00:00.000Z"),
      endedAt: new Date("2027-06-15T18:00:00.000Z")
    };
    const label = activityDayTimeLabel(yearApart, day, zone);
    expect(label.spansDays).toBe(true);
    expect(label.text).toBe("Jun 15 2:00 PM - Jun 15 2:00 PM");

    // And across a new year, where the day-of-month alone would also read as different.
    const acrossNewYear = {
      startedAt: new Date("2026-12-31T23:00:00.000Z"),
      endedAt: new Date("2027-01-01T11:00:00.000Z")
    };
    expect(activityDayTimeLabel(acrossNewYear, day, zone).spansDays).toBe(true);

    // A month apart on the same day-of-month, which the day number alone would also miss.
    const monthApart = {
      startedAt: new Date("2026-05-15T18:00:00.000Z"),
      endedAt: new Date("2026-06-15T18:00:00.000Z")
    };
    expect(activityDayTimeLabel(monthApart, day, zone).spansDays).toBe(true);
  });
  it("writes a single-digit day without padding it", () => {
    // Every other dated label here lands on a two-digit day, so a shape that zero-padded the day
    // would read "Oct 01" and no test would notice. A family writes it the way they say it.
    const intoOctober = {
      startedAt: new Date("2026-09-30T23:30:00.000Z"),
      endedAt: new Date("2026-10-01T09:30:00.000Z")
    };
    expect(activityDayTimeLabel(intoOctober, day, zone).text).toBe("Sep 30 7:30 PM - Oct 1 5:30 AM");
  });

  it("does not mistake the clocks changing for a change of day", () => {
    // The day comparison must contain nothing that varies WITHIN a day. On the morning the clocks
    // spring forward the two ends of this nap sit in different offsets, so anything carrying the
    // zone's abbreviation would differ between them and the nap would wrongly claim it crossed
    // midnight - it began at 1:30 and ended at 3:30 the same morning.
    const acrossTheSpringForward = {
      startedAt: new Date("2026-03-08T06:30:00.000Z"),
      endedAt: new Date("2026-03-08T07:30:00.000Z")
    };
    const label = activityDayTimeLabel(acrossTheSpringForward, day, zone);
    expect(label.spansDays).toBe(false);
    expect(label.text).toBe("1:30 AM - 3:30 AM");

    // And the autumn transition, where an hour repeats instead of vanishing.
    const acrossTheFallBack = {
      startedAt: new Date("2026-11-01T05:30:00.000Z"),
      endedAt: new Date("2026-11-01T06:30:00.000Z")
    };
    expect(activityDayTimeLabel(acrossTheFallBack, day, zone).spansDays).toBe(false);
  });
});
