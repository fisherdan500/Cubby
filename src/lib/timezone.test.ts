import { describe, expect, it } from "vitest";
import {
  addDaysToDateKey,
  dateKeyInTimeZone,
  DEFAULT_APP_TIMEZONE,
  dateTimeInputValue,
  displayFormatter,
  formatCalendarDate,
  formatInstant,
  formatInstantDate,
  isValidTimeZone,
  normalizeTimeZone,
  zonedDateStart,
  zonedDateTimeToDate
} from "@/lib/timezone";

// Intl may separate "4:00" and "PM" with a narrow no-break space; normalize so assertions read plainly.
const plain = (value: string) => value.replace(/\s/g, " ");

describe("display-time helpers", () => {
  it("shows an instant in the household zone, whatever the process or device zone", () => {
    const instant = new Date("2026-07-15T20:00:00.000Z");
    expect(plain(formatInstant(instant, "America/New_York"))).toBe("Jul 15, 2026, 4:00 PM");
    expect(plain(formatInstant(instant, "UTC"))).toBe("Jul 15, 2026, 8:00 PM");
    expect(plain(formatInstant(instant.toISOString(), "America/New_York", { withYear: false }))).toBe("Jul 15, 4:00 PM");
  });

  it("follows daylight-saving changes on both sides of the spring and autumn transitions", () => {
    // 2026-03-08: New York jumps from 2:00 EST to 3:00 EDT at 07:00Z.
    expect(plain(formatInstant(new Date("2026-03-08T06:30:00.000Z"), "America/New_York"))).toBe("Mar 8, 2026, 1:30 AM");
    expect(plain(formatInstant(new Date("2026-03-08T07:30:00.000Z"), "America/New_York"))).toBe("Mar 8, 2026, 3:30 AM");
    // 2026-11-01: 1:00-2:00 happens twice; 05:30Z is the first (EDT) and 06:30Z the second (EST).
    expect(plain(formatInstant(new Date("2026-11-01T05:30:00.000Z"), "America/New_York"))).toBe("Nov 1, 2026, 1:30 AM");
    expect(plain(formatInstant(new Date("2026-11-01T06:30:00.000Z"), "America/New_York"))).toBe("Nov 1, 2026, 1:30 AM");
  });

  it("gives an instant's household calendar day, which can differ from the UTC day", () => {
    expect(formatInstantDate(new Date("2026-01-02T03:00:00.000Z"), "America/New_York")).toBe("Jan 1, 2026");
    expect(formatInstantDate(new Date("2026-01-02T03:00:00.000Z"), "UTC")).toBe("Jan 2, 2026");
  });

  it("keeps a date-only value (a birth date stored as midnight UTC) on its own calendar day", () => {
    // Formatting this in New York local time used to show Aug 16.
    expect(formatCalendarDate(new Date("2026-08-17"))).toBe("Aug 17, 2026");
    expect(formatCalendarDate("2026-08-17T00:00:00.000Z")).toBe("Aug 17, 2026");
  });

  it("returns an empty string for missing or unparseable values instead of 'Invalid Date'", () => {
    expect(formatInstant(null, "UTC")).toBe("");
    expect(formatInstant("not a date", "UTC")).toBe("");
    expect(formatCalendarDate(undefined)).toBe("");
  });

  it("recognises real IANA zones and rejects typos", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_Yrok")).toBe(false);
    expect(isValidTimeZone("EST5EDT-not")).toBe(false);
  });
});

describe("timezone helpers", () => {
  it("normalizes invalid timezones to a safe fallback", () => {
    expect(normalizeTimeZone("Not/AZone", "America/New_York")).toBe("America/New_York");
  });

  it("formats datetime-local values in the configured timezone", () => {
    expect(dateTimeInputValue(new Date("2026-06-19T04:30:00.000Z"), "America/New_York")).toBe("2026-06-19T00:30");
  });

  it("parses datetime-local values as configured timezone wall time", () => {
    expect(zonedDateTimeToDate("2026-06-19T00:30", "America/New_York").toISOString()).toBe("2026-06-19T04:30:00.000Z");
  });

  it("builds date keys in the configured timezone", () => {
    expect(dateKeyInTimeZone(new Date("2026-06-19T03:30:00.000Z"), "America/New_York")).toBe("2026-06-18");
  });
});

describe("reusing the work behind a zone lookup", () => {
  // Naming a day in a zone means building an Intl formatter, and building one costs about thirteen
  // times what using it costs. Reports formats once per entry and the calendar twice per visible
  // day, so the formatters are kept and reused. These pin that keeping them cannot change an
  // answer - the hazard of any cache - rather than pinning that it is fast.

  it("gives the same answer whichever zone was asked about first", () => {
    // A formatter held for one zone must never answer for another.
    const instant = new Date("2026-07-15T23:30:00.000Z");
    const newYorkFirst = dateKeyInTimeZone(instant, "America/New_York");
    const tokyo = dateKeyInTimeZone(instant, "Asia/Tokyo");
    const newYorkAgain = dateKeyInTimeZone(instant, "America/New_York");

    expect(newYorkFirst).toBe("2026-07-15");
    expect(tokyo).toBe("2026-07-16");
    expect(newYorkAgain).toBe(newYorkFirst);
  });

  it("still finds midnight correctly on both daylight-saving days", () => {
    // The spring day is 23 hours long and the autumn day 25, and each is reached twice here: once
    // cold and once after the zone's formatter has been kept.
    const spring = "2026-03-08";
    const autumn = "2026-11-01";
    const springStart = zonedDateStart(spring, "America/New_York");
    const autumnStart = zonedDateStart(autumn, "America/New_York");

    expect(springStart.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(autumnStart.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(zonedDateStart(spring, "America/New_York").getTime()).toBe(springStart.getTime());
    expect(zonedDateStart(autumn, "America/New_York").getTime()).toBe(autumnStart.getTime());
  });

  it("keeps every day of a year distinct, so a kept formatter cannot smear two days together", () => {
    const keys = new Set<string>();
    for (let index = 0; index < 365; index += 1) {
      const key = addDaysToDateKey("2026-01-01", index);
      keys.add(zonedDateStart(key, "America/New_York").toISOString());
    }

    expect(keys.size).toBe(365);
  });

  it("midnight in the zone is still midnight when read back in the zone", () => {
    // The round trip is the real invariant: whatever instant this returns must name the day asked
    // for when it is formatted back.
    for (const key of ["2026-01-15", "2026-03-08", "2026-06-15", "2026-11-01", "2026-12-31"]) {
      expect(dateKeyInTimeZone(zonedDateStart(key, "America/New_York"), "America/New_York")).toBe(key);
      expect(dateKeyInTimeZone(zonedDateStart(key, "Asia/Kolkata"), "Asia/Kolkata")).toBe(key);
    }
  });

  it("an unusable zone still falls back, and asking twice does not change the fallback", () => {
    const first = normalizeTimeZone("Not/AZone");
    const second = normalizeTimeZone("Not/AZone");

    expect(first).toBe(DEFAULT_APP_TIMEZONE);
    expect(second).toBe(first);
    expect(normalizeTimeZone("")).toBe(DEFAULT_APP_TIMEZONE);
    expect(normalizeTimeZone(undefined)).toBe(DEFAULT_APP_TIMEZONE);
    // A real zone asked after a bad one must not inherit the fallback.
    expect(normalizeTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("handles a zone on a non-hour offset, where a careless cache key would collide", () => {
    expect(zonedDateStart("2026-06-15", "Asia/Kolkata").toISOString()).toBe("2026-06-14T18:30:00.000Z");
    expect(zonedDateStart("2026-06-15", "Australia/Adelaide").toISOString()).toBe("2026-06-14T14:30:00.000Z");
  });
  it("keeps the date-only and with-time lookups apart", () => {
    // Both ask the same zone but need different fields. Sharing one entry would hand the with-time
    // caller a formatter that was never asked for an hour, and the time would read as NaN.
    const instant = new Date("2026-07-15T23:30:00.000Z");

    // Date path first, so a shared entry would be the date-only one.
    expect(dateKeyInTimeZone(instant, "America/New_York")).toBe("2026-07-15");
    expect(dateTimeInputValue(instant, "America/New_York")).toBe("2026-07-15T19:30");
    // And the other way round, in case the with-time entry is the one that wins.
    expect(dateTimeInputValue(instant, "Asia/Tokyo")).toBe("2026-07-16T08:30");
    expect(dateKeyInTimeZone(instant, "Asia/Tokyo")).toBe("2026-07-16");
  });

  it("keeps two different zones apart under the same fallback", () => {
    // The mirror of the case below: same fallback, different zones. Both are perfectly valid, so a
    // lookup that kept only one answer per fallback would hand the second caller the first's zone -
    // and every date in the app is grouped through this answer.
    expect(normalizeTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(normalizeTimeZone("Europe/Paris")).toBe("Europe/Paris");
    expect(normalizeTimeZone("America/New_York")).toBe("America/New_York");
    // Asked again, after all three are remembered.
    expect(normalizeTimeZone("Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(normalizeTimeZone("Europe/Paris")).toBe("Europe/Paris");
  });

  it("answers for the fallback it was given, not the one it was asked about first", () => {
    // The same unusable zone resolves differently depending on what to fall back to, so the
    // fallback belongs in the lookup as much as the zone does.
    expect(normalizeTimeZone("Bad/Zone", "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(normalizeTimeZone("Bad/Zone", "UTC")).toBe("UTC");
    expect(normalizeTimeZone("Bad/Zone")).toBe(DEFAULT_APP_TIMEZONE);
    // Asked again in a different order, the answers must not have swapped.
    expect(normalizeTimeZone("Bad/Zone", "UTC")).toBe("UTC");
    expect(normalizeTimeZone("Bad/Zone", "Asia/Tokyo")).toBe("Asia/Tokyo");
  });

  it("still reads an unusable zone in the fallback rather than trusting it", () => {
    // Formatting with an unchecked zone is how an unusable one reaches Intl and throws, so the
    // zone has to be resolved before the formatter is looked up.
    const instant = new Date("2026-07-15T23:30:00.000Z");

    // The fallback is America/New_York, where this instant is still the 15th.
    expect(dateKeyInTimeZone(instant, "Not/AZone")).toBe("2026-07-15");
    expect(() => dateKeyInTimeZone(instant, "Not/AZone")).not.toThrow();
    // And a real zone asked afterwards is unaffected.
    expect(dateKeyInTimeZone(instant, "Asia/Tokyo")).toBe("2026-07-16");
  });
  it("reads an unusable zone in the fallback when a time of day is wanted too", () => {
    // The with-time path resolves the zone separately from the date-only path, so it needs its own
    // case: an unusable zone must land in the fallback rather than reaching Intl and throwing.
    const instant = new Date("2026-07-15T23:30:00.000Z");

    expect(dateTimeInputValue(instant, "Not/AZone")).toBe("2026-07-15T19:30");
    expect(() => dateTimeInputValue(instant, "Not/AZone")).not.toThrow();
  });

  it("lands on the exact instant of local midnight, not merely near it", () => {
    // Finding the UTC instant for a local wall time takes repeated correction. One pass alone lands
    // close enough to look right in summer and be an hour out across a daylight-saving boundary, so
    // the assertion has to be the exact instant on days where the offset moves.
    expect(zonedDateStart("2026-03-08", "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(zonedDateStart("2026-03-09", "America/New_York").toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(zonedDateStart("2026-11-01", "America/New_York").toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(zonedDateStart("2026-11-02", "America/New_York").toISOString()).toBe("2026-11-02T05:00:00.000Z");
    // A zone whose offset is not a whole hour.
    expect(zonedDateStart("2026-06-15", "Asia/Kolkata").toISOString()).toBe("2026-06-14T18:30:00.000Z");
    expect(zonedDateTimeToDate("2026-06-15T14:45", "Australia/Adelaide").toISOString()).toBe("2026-06-15T05:15:00.000Z");

    // The cases that actually need more than one correction: a wall time inside the hour the clocks
    // move. Reached here because an activity really can be logged at half past two in the morning.
    expect(zonedDateTimeToDate("2026-03-08T02:30", "America/New_York").toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(zonedDateTimeToDate("2026-11-01T02:30", "America/New_York").toISOString()).toBe("2026-11-01T07:30:00.000Z");
  });
  it("names a leap day and years well beyond the ones hard-coded here", () => {
    // Every other date assertion in this file is a 2026 date, so a fault that only shows up on a
    // leap day, or after some future year, would go unnoticed. Both are ordinary days to a family
    // using the app then.
    const leapDay = new Date("2028-02-29T16:00:00.000Z");
    expect(dateKeyInTimeZone(leapDay, "America/New_York")).toBe("2028-02-29");
    expect(zonedDateStart("2028-02-29", "America/New_York").toISOString()).toBe("2028-02-29T05:00:00.000Z");
    // The day after, so a leap day quietly read as the 28th would show up as a repeat.
    expect(dateKeyInTimeZone(new Date("2028-03-01T16:00:00.000Z"), "America/New_York")).toBe("2028-03-01");

    expect(dateKeyInTimeZone(new Date("2031-07-04T16:00:00.000Z"), "America/New_York")).toBe("2031-07-04");
    expect(dateKeyInTimeZone(new Date("2040-12-31T18:00:00.000Z"), "America/New_York")).toBe("2040-12-31");
    // Across midnight in the zone, where the year rolls over but the instant is still the old year.
    expect(dateKeyInTimeZone(new Date("2041-01-01T04:00:00.000Z"), "America/New_York")).toBe("2040-12-31");
    expect(dateTimeInputValue(new Date("2032-02-29T13:45:00.000Z"), "Asia/Kolkata")).toBe("2032-02-29T19:15");
  });
  it("shows a time of day in the household's zone, whichever was asked for last", () => {
    // These formatters are kept between calls, and a page shows a lot of items, so the zone has to
    // be part of what is kept: the same moment is a different time of day in each household.
    const instant = new Date("2026-06-15T23:30:00.000Z");
    expect(displayFormatter("timeOfDay", "America/New_York").format(instant)).toBe("7:30 PM");
    expect(displayFormatter("timeOfDay", "Asia/Tokyo").format(instant)).toBe("8:30 AM");
    expect(displayFormatter("timeOfDay", "UTC").format(instant)).toBe("11:30 PM");
    // Asked again, after all three are remembered.
    expect(displayFormatter("timeOfDay", "Asia/Tokyo").format(instant)).toBe("8:30 AM");
    expect(displayFormatter("timeOfDay", "America/New_York").format(instant)).toBe("7:30 PM");
  });

  it("keeps the time of day and the bare hour apart", () => {
    // One is read by a person, the other is parsed as a number to decide whether something happened
    // in the morning or at night. Sharing a kept formatter between them would turn "7:30 PM" into
    // the input of a Number() and give NaN, or label the evening as the small hours.
    const evening = new Date("2026-06-15T23:30:00.000Z");
    expect(displayFormatter("timeOfDay", "America/New_York").format(evening)).toBe("7:30 PM");
    expect(Number(displayFormatter("hourOfDay", "America/New_York").format(evening))).toBe(19);

    // The hour must count from zero, so midnight is 0 rather than 24 or 12.
    const justAfterMidnight = new Date("2026-06-15T04:30:00.000Z");
    expect(Number(displayFormatter("hourOfDay", "America/New_York").format(justAfterMidnight))).toBe(0);
    // And the displayed shape still reads as a time afterwards.
    expect(displayFormatter("timeOfDay", "America/New_York").format(justAfterMidnight)).toBe("12:30 AM");
  });

  it("reads an unusable zone in the fallback rather than failing a page", () => {
    // Every caller passes the installation's configured zone today, so this cannot happen now. It is
    // pinned because a time beside an entry should not be what takes a whole page down if a stored
    // zone is ever unreadable - the rest of the module already resolves rather than throws.
    const instant = new Date("2026-06-15T23:30:00.000Z");
    expect(displayFormatter("timeOfDay", "Not/AZone").format(instant)).toBe("7:30 PM");
    expect(displayFormatter("timeOfDay", "").format(instant)).toBe("7:30 PM");
    expect(() => displayFormatter("hourOfDay", "Not/AZone")).not.toThrow();
  });
  it("reads a day heading in UTC however the caller's zone is set", () => {
    // A day key is a calendar date with no instant behind it, stored as midnight UTC. Read in a zone
    // west of UTC it would land on the day before, so these two shapes name their own zone and the
    // caller's must not override it - including the household zone, which is where that would hurt.
    const dayKeyAsInstant = new Date(Date.UTC(2026, 5, 15));
    expect(displayFormatter("dayHeading", "UTC").format(dayKeyAsInstant)).toBe("Mon, Jun 15");
    expect(displayFormatter("dayHeading", "America/New_York").format(dayKeyAsInstant)).toBe("Mon, Jun 15");
    expect(displayFormatter("dayHeading", "Asia/Tokyo").format(dayKeyAsInstant)).toBe("Mon, Jun 15");

    // An earlier year has to say which year it was.
    expect(displayFormatter("dayHeadingWithYear", "UTC").format(new Date(Date.UTC(2025, 5, 15))))
      .toBe("Sun, Jun 15, 2025");
    expect(displayFormatter("dayHeadingWithYear", "America/New_York").format(new Date(Date.UTC(2025, 5, 15))))
      .toBe("Sun, Jun 15, 2025");

    // The first of a month, where slipping a day also changes the month.
    expect(displayFormatter("dayHeading", "America/New_York").format(new Date(Date.UTC(2026, 0, 1))))
      .toBe("Thu, Jan 1");
  });
});
