/**
 * How an activity's time reads on a day's log.
 *
 * Most entries are a single moment and read as one time. An activity that crosses midnight has to
 * say more: on the morning it ended, "8:30 AM" alone would be a lie about when it happened, so it
 * carries both ends with dates attached, the way a family would say it out loud.
 */
import { describe, expect, it } from "vitest";

import { activityDayTimeLabel } from "./activity";

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
});
