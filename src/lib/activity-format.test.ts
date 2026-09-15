import { describe, expect, it } from "vitest";
import { formatElapsedBadge, formatVolume } from "@/lib/activity-format";

describe("activity formatting", () => {
  it("formats elapsed badge time as hours and padded minutes", () => {
    expect(formatElapsedBadge(new Date("2026-06-19T14:31:00.000Z"), new Date("2026-06-19T17:05:00.000Z"))).toBe("2:34");
  });

  it("does not produce negative elapsed badge time", () => {
    expect(formatElapsedBadge(new Date("2026-06-19T18:00:00.000Z"), new Date("2026-06-19T17:05:00.000Z"))).toBe("0:00");
  });

  it("shows a volume as saved, adding an approximate conversion only when the unit differs from the display unit", () => {
    expect(formatVolume(120, "mL", "oz")).toBe("120 mL (≈ 4.1 oz)");
    expect(formatVolume(4, "oz", "mL")).toBe("4 oz (≈ 118 mL)");
    expect(formatVolume(4, "oz", "oz")).toBe("4 oz");
    expect(formatVolume(4, "fl oz", "oz")).toBe("4 fl oz");
    expect(formatVolume(120, "ml", undefined)).toBe("120 ml");
    expect(formatVolume(2, "scoops", "oz")).toBe("2 scoops");
    expect(formatVolume(3, null, "mL")).toBe("3");
  });
});
