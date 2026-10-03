import { describe, expect, it } from "vitest";
import { buildTrends } from "@/server/services/trends";

const timeZone = "America/New_York";

function at(localDateTime: string) {
  // Fixed offsets for the dates used here; America/New_York is UTC-4 in June and September 2026.
  return new Date(`${localDateTime}:00.000-04:00`);
}

function feed(localDateTime: string, amount: number | null = null) {
  return {
    type: "feeding" as const,
    occurredAt: at(localDateTime),
    startedAt: null,
    endedAt: null,
    durationSeconds: null,
    timerState: "none",
    pausedAt: null,
    feedingAmount: amount,
    feedingMode: amount === null ? "breast" : "bottle"
  };
}

function diaper(localDateTime: string) {
  return {
    type: "diaper" as const,
    occurredAt: at(localDateTime),
    startedAt: null,
    endedAt: null,
    durationSeconds: null,
    timerState: "none",
    pausedAt: null,
    feedingAmount: null,
    feedingMode: null
  };
}

function sleep(startLocal: string, endLocal: string) {
  return {
    type: "sleep" as const,
    occurredAt: at(startLocal),
    startedAt: at(startLocal),
    endedAt: at(endLocal),
    durationSeconds: Math.round((at(endLocal).getTime() - at(startLocal).getTime()) / 1000),
    timerState: "stopped",
    pausedAt: null,
    feedingAmount: null,
    feedingMode: null
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

      const points = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).sleep.points;
      const first = points.find((point) => point.weekKey === "2026-06-01");

      // 1 June holds 7h of the night before plus 5h of its own evening: a full twelve hours. With
      // the night before ignored it would read 5h, and the week would open on a false low.
      expect(first).toBeDefined();
      expect((first?.value as number) * (first?.daysCounted ?? 0)).toBeGreaterThanOrEqual(12 * 3600);
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
    it("stays blank while most feeds are breastfeeds, which carry no volume", () => {
      const activities = [];
      for (let day = 1; day <= 5; day += 1) {
        for (let n = 0; n < 10; n += 1) activities.push(feed(`2026-06-0${day}T${String(6 + n).padStart(2, "0")}:00`));
        activities.push(feed(`2026-06-0${day}T20:00`, 4));
      }

      const [week] = buildTrends(activities, { timeZone, now: at("2026-06-08T12:00").getTime() }).volume.points;

      // One measured feed in eleven: reporting 4oz a day would read as near-starvation.
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
          activities.push(feed(`2026-06-${date}T${String(6 + n).padStart(2, "0")}:00`, unmeasured ? null : 4));
        }
      }

      const [week] = buildTrends(activities, { timeZone, now: at("2026-06-10T12:00").getTime() }).volume.points;

      // Every measured feed is 4oz, so the honest figure is 40oz a day however many went unrecorded.
      expect(week.value).toBeCloseTo(40, 1);
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
});
