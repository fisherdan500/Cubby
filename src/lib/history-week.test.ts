import { describe, expect, it } from "vitest";
import { resolveHistoryWeek } from "@/lib/history-week";

const zone = "America/New_York";

describe("resolveHistoryWeek", () => {
  it("preserves Gregorian years below 100 and a final Monday crossing year 9999", () => {
    expect(resolveHistoryWeek("0001-01-01", "UTC")).toEqual({
      status: "valid", key: "0001-01-01",
      start: new Date("0001-01-01T00:00:00Z"), end: new Date("0001-01-08T00:00:00Z")
    });
    expect(resolveHistoryWeek("0001-01-01", zone)).toEqual({
      status: "valid", key: "0001-01-01",
      start: new Date("0001-01-01T04:56:02Z"), end: new Date("0001-01-08T04:56:02Z")
    });
    expect(resolveHistoryWeek("9999-12-27", "UTC")).toEqual({
      status: "valid", key: "9999-12-27",
      start: new Date("9999-12-27T00:00:00Z"), end: new Date("+010000-01-03T00:00:00Z")
    });
  });
  it("resolves both DST weeks with local Monday midnights, not 168 hours", () => {
    expect(resolveHistoryWeek("2026-03-02", zone)).toEqual({
      status: "valid", key: "2026-03-02",
      start: new Date("2026-03-02T05:00:00Z"), end: new Date("2026-03-09T04:00:00Z")
    });
    expect(resolveHistoryWeek("2026-10-26", zone)).toEqual({
      status: "valid", key: "2026-10-26",
      start: new Date("2026-10-26T04:00:00Z"), end: new Date("2026-11-02T05:00:00Z")
    });
  });
  it("rejects arrays even with one key, duplicate keys, and non-string inputs", () => {
    for (const input of [["2026-02-02"], ["2026-02-02", "2026-02-02"], [], null, 20260202, { toString: () => "2026-02-02" }]) {
      expect(resolveHistoryWeek(input, zone)).toEqual({ status: "invalid" });
    }
  });
  it("rejects a real date that is not Monday", () => {
    for (const key of ["2026-02-03", "2026-02-04", "2026-02-05", "2026-02-06", "2026-02-07", "2026-02-08"]) {
      expect(resolveHistoryWeek(key, zone)).toEqual({ status: "invalid" });
    }
  });
  it("rejects impossible Gregorian dates, including non-leap centuries", () => {
    for (const key of ["2026-02-30", "2026-02-29", "1900-02-29", "2026-13-01", "2026-00-01", "2026-01-00", "0000-01-03"]) {
      expect(resolveHistoryWeek(key, zone)).toEqual({ status: "invalid" });
    }
  });
  it("rejects empty or malformed widths instead of throwing or normalizing", () => {
    for (const key of ["", "2026-2-02", "26-02-02", "2026-02-2", " 2026-02-02", "2026-02-02T00:00:00Z", "nonsense"]) {
      expect(resolveHistoryWeek(key, zone)).toEqual({ status: "invalid" });
    }
  });
  it("distinguishes an absent key from a valid Monday", () => {
    expect(resolveHistoryWeek(undefined, zone)).toEqual({ status: "absent" });
    expect(resolveHistoryWeek("2026-02-02", zone)).toEqual({
      status: "valid", key: "2026-02-02",
      start: new Date("2026-02-02T05:00:00Z"), end: new Date("2026-02-09T05:00:00Z")
    });
  });
});
