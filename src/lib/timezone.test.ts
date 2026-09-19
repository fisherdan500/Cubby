import { describe, expect, it } from "vitest";
import {
  dateKeyInTimeZone,
  dateTimeInputValue,
  formatCalendarDate,
  formatInstant,
  formatInstantDate,
  isValidTimeZone,
  normalizeTimeZone,
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
