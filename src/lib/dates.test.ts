import { describe, expect, it } from "vitest";
import { durationSeconds, parseDateInput } from "@/lib/dates";

describe("date helpers", () => {
  it("computes positive durations in seconds", () => {
    expect(durationSeconds(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:03:30Z"))).toBe(210);
  });

  it("rounds fractional positive durations to the nearest second", () => {
    const start = new Date("2026-01-01T00:00:00.000Z");
    expect(durationSeconds(start, new Date("2026-01-01T00:00:01.499Z"))).toBe(1);
    expect(durationSeconds(start, new Date("2026-01-01T00:00:01.500Z"))).toBe(2);
  });

  it("quantizes both boundaries onto the canonical absolute-second grid", () => {
    expect(durationSeconds(
      new Date("2026-01-01T00:00:00.400Z"),
      new Date("2026-01-01T00:00:10.800Z")
    )).toBe(11);
  });

  it("does not return negative duration", () => {
    expect(durationSeconds(new Date("2026-01-01T01:00:00Z"), new Date("2026-01-01T00:00:00Z"))).toBe(0);
  });

  it("rejects invalid date input", () => {
    expect(() => parseDateInput("not-a-date")).toThrow("Invalid date");
  });
});
