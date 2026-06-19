import { describe, expect, it } from "vitest";
import { durationSeconds, parseDateInput } from "@/lib/dates";

describe("date helpers", () => {
  it("computes positive durations in seconds", () => {
    expect(durationSeconds(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:03:30Z"))).toBe(210);
  });

  it("does not return negative duration", () => {
    expect(durationSeconds(new Date("2026-01-01T01:00:00Z"), new Date("2026-01-01T00:00:00Z"))).toBe(0);
  });

  it("rejects invalid date input", () => {
    expect(() => parseDateInput("not-a-date")).toThrow("Invalid date");
  });
});
