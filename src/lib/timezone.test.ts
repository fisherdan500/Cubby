import { describe, expect, it } from "vitest";
import { dateKeyInTimeZone, dateTimeInputValue, normalizeTimeZone, zonedDateTimeToDate } from "@/lib/timezone";

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
