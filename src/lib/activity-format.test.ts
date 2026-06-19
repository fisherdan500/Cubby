import { describe, expect, it } from "vitest";
import { formatElapsedBadge } from "@/lib/activity-format";

describe("activity formatting", () => {
  it("formats elapsed badge time as hours and padded minutes", () => {
    expect(formatElapsedBadge(new Date("2026-06-19T14:31:00.000Z"), new Date("2026-06-19T17:05:00.000Z"))).toBe("2:34");
  });

  it("does not produce negative elapsed badge time", () => {
    expect(formatElapsedBadge(new Date("2026-06-19T18:00:00.000Z"), new Date("2026-06-19T17:05:00.000Z"))).toBe("0:00");
  });
});
