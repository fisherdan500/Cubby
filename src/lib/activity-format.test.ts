import { describe, expect, it } from "vitest";
import { formatElapsedBadge, formatTimeSince, formatVolume } from "@/lib/activity-format";

describe("activity formatting", () => {
  it("says how long ago something happened in words a tired reader can take in at a glance", () => {
    const now = new Date("2026-06-19T17:05:00.000Z");
    expect(formatTimeSince(new Date("2026-06-19T17:04:40.000Z"), now)).toBe("just now");
    expect(formatTimeSince(new Date("2026-06-19T16:48:00.000Z"), now)).toBe("17m ago");
    expect(formatTimeSince(new Date("2026-06-19T14:31:00.000Z"), now)).toBe("2h 34m ago");
    expect(formatTimeSince(new Date("2026-06-19T14:05:00.000Z"), now)).toBe("3h ago");
    expect(formatTimeSince(new Date("2026-06-16T17:05:00.000Z"), now)).toBe("3d ago");
  });

  it("never reports a future time as a negative duration", () => {
    expect(formatTimeSince(new Date("2026-06-19T18:00:00.000Z"), new Date("2026-06-19T17:05:00.000Z"))).toBe("just now");
    expect(formatTimeSince(null)).toBeNull();
  });

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
