import { describe, expect, it } from "vitest";
import {
  addMinutes,
  formatClock,
  formatDay,
  formatMinutes,
  formatRelative,
  formatWall,
  from12Hour,
  isWallTime,
  joinWall,
  minutesBetween,
  nowWallTime,
  to12Hour,
  wallParts
} from "@/lib/wall-time";

describe("wall time helpers", () => {
  it("reads now in the household timezone, not the device timezone", () => {
    const instant = new Date("2026-09-15T03:30:00.000Z");
    expect(nowWallTime("America/New_York", instant)).toBe("2026-09-14T23:30");
    expect(nowWallTime("UTC", instant)).toBe("2026-09-15T03:30");
  });

  it("does wall-clock arithmetic across midnight, month and year boundaries", () => {
    expect(addMinutes("2026-09-15T00:03", -5)).toBe("2026-09-14T23:58");
    expect(addMinutes("2026-12-31T23:50", 15)).toBe("2027-01-01T00:05");
    expect(addMinutes("2028-02-28T23:59", 1)).toBe("2028-02-29T00:00");
    expect(minutesBetween("2026-09-14T23:50", "2026-09-15T00:20")).toBe(30);
  });

  it("validates and splits the API wall-time format", () => {
    expect(isWallTime("2026-09-15T07:05")).toBe(true);
    expect(isWallTime("2026-09-15T07:05:00")).toBe(false);
    expect(isWallTime("")).toBe(false);
    expect(wallParts("2026-09-15T07:05")).toEqual({ date: "2026-09-15", hour: 7, minute: 5 });
    expect(joinWall({ date: "2026-09-15", hour: 7, minute: 5 })).toBe("2026-09-15T07:05");
  });

  it("converts 12-hour selections without midnight/noon mistakes", () => {
    expect(to12Hour(0)).toEqual({ hour12: 12, period: "AM" });
    expect(to12Hour(12)).toEqual({ hour12: 12, period: "PM" });
    expect(to12Hour(15)).toEqual({ hour12: 3, period: "PM" });
    expect(from12Hour(12, "AM")).toBe(0);
    expect(from12Hour(12, "PM")).toBe(12);
    expect(from12Hour(3, "PM")).toBe(15);
  });

  it("formats friendly labels", () => {
    const now = "2026-09-15T15:47";
    expect(formatClock("2026-09-15T00:07")).toBe("12:07 AM");
    expect(formatWall("2026-09-15T15:32", now)).toBe("Today, 3:32 PM");
    expect(formatDay("2026-09-14T23:00", now)).toBe("Yesterday");
    expect(formatDay("2026-09-12T08:00", now)).toBe("Sat, Sep 12");
    expect(formatDay("2025-12-30T08:00", now)).toBe("Tue, Dec 30, 2025");
    expect(formatMinutes(95)).toBe("1 hr 35 min");
    expect(formatMinutes(60)).toBe("1 hr");
    expect(formatRelative("2026-09-15T15:32", now)).toBe("15 min ago");
    expect(formatRelative(now, now)).toBe("Right now");
    expect(formatRelative("2026-09-15T15:52", now)).toBe("In 5 min");
  });
});
