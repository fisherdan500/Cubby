import { describe, expect, it } from "vitest";
import { describeActivity, formatElapsedBadge, formatFinishedStretch, formatTimeSince, formatVolume } from "@/lib/activity-format";
import type { ActivityWithDetails } from "@/lib/activity-format";

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

describe("a finished stretch says when it ended, not how many minutes it ran", () => {
  const ZONE = "America/New_York";

  function stretch(startedAt: string, endedAt: string | null, durationSeconds: number | null) {
    return {
      startedAt: startedAt ? new Date(startedAt) : null,
      endedAt: endedAt ? new Date(endedAt) : null,
      occurredAt: new Date(startedAt),
      durationSeconds
    };
  }

  it("names the end time so nobody has to add minutes to a start", () => {
    // 1:05 PM + 95 min is the arithmetic a caregiver should never have to do.
    const nap = stretch("2026-03-10T17:05:00Z", "2026-03-10T18:40:00Z", 95 * 60);
    expect(formatFinishedStretch(nap, ZONE)).toBe("ended 2:40 PM");
  });

  it("carries the date when the stretch crossed midnight", () => {
    // "ended 6:10 AM" alone leaves the reader asking which morning.
    const overnight = stretch("2026-03-10T03:30:00Z", "2026-03-11T10:10:00Z", 7 * 3600);
    expect(formatFinishedStretch(overnight, ZONE)).toBe("ended Mar 11 6:10 AM");
  });

  it("does not read a DST afternoon as overnight", () => {
    // Clocks jumped forward this morning, so the zone abbreviation changed mid-day. A day key that
    // included it would call this nap overnight and print a spurious date.
    const dstNap = stretch("2026-03-08T17:00:00Z", "2026-03-08T18:30:00Z", 90 * 60);
    expect(formatFinishedStretch(dstNap, ZONE)).toBe("ended 2:30 PM");
  });

  it("falls back to the duration when there is no end instant", () => {
    // A hand-entered "15 min" with no end time still has something true to say.
    const handEntered = stretch("2026-03-10T17:05:00Z", null, 15 * 60);
    expect(formatFinishedStretch(handEntered, ZONE)).toBe("15 min");
  });

  it("falls back to the duration when no zone is available", () => {
    const nap = stretch("2026-03-10T17:05:00Z", "2026-03-10T18:40:00Z", 95 * 60);
    expect(formatFinishedStretch(nap, undefined)).toBe("1h 35m");
  });

  it.each(["feeding", "sleep", "pumping", "play"])(
    "%s summaries show the end time, not a minute count",
    (type) => {
      const activity = {
        type,
        startedAt: new Date("2026-03-10T17:05:00Z"),
        endedAt: new Date("2026-03-10T18:40:00Z"),
        occurredAt: new Date("2026-03-10T17:05:00Z"),
        durationSeconds: 95 * 60,
        timerState: "stopped",
        feeding: { method: "bottle" },
        sleep: { location: "crib" },
        pumping: { side: "both" },
        play: { activityName: "tummy time" }
      } as unknown as ActivityWithDetails;

      const summary = describeActivity(activity, { timeZone: ZONE });
      expect(summary).toContain("ended 2:40 PM");
      expect(summary).not.toContain("95 min");
      expect(summary).not.toContain("1h 35m");
    }
  );
});
