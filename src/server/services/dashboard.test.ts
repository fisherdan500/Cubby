import { describe, expect, it } from "vitest";
import { TimerState } from "@prisma/client";
import {
  addDaysToDateKey,
  buildDashboardWarningItems,
  filterDismissedWarnings,
  resolveDashboardDate
} from "@/server/services/dashboard";

describe("dashboard warnings", () => {
  it("builds overdue warning items and filters dismissed fingerprints", () => {
    const warnings = buildDashboardWarningItems({
      babyId: "baby-1",
      lastFeeding: { occurredAt: new Date("2026-06-19T14:00:00.000Z") },
      lastDiaper: { occurredAt: new Date("2026-06-19T17:00:00.000Z") },
      activeTimers: [],
      feedingWarningMinutes: 120,
      diaperWarningMinutes: 180,
      now: new Date("2026-06-19T18:00:00.000Z")
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      babyId: "baby-1",
      type: "feeding",
      message: "Long time since feeding"
    });
    expect(filterDismissedWarnings(warnings, [{ type: "feeding", fingerprint: warnings[0].fingerprint }])).toEqual([]);
  });

  it("changes the feeding fingerprint when a newer feeding is logged", () => {
    const older = buildDashboardWarningItems({
      babyId: "baby-1",
      lastFeeding: { occurredAt: new Date("2026-06-19T14:00:00.000Z") },
      lastDiaper: { occurredAt: new Date("2026-06-19T18:00:00.000Z") },
      activeTimers: [],
      feedingWarningMinutes: 120,
      now: new Date("2026-06-19T18:00:00.000Z")
    }).find((warning) => warning.type === "feeding");
    const newer = buildDashboardWarningItems({
      babyId: "baby-1",
      lastFeeding: { occurredAt: new Date("2026-06-19T15:30:00.000Z") },
      lastDiaper: { occurredAt: new Date("2026-06-19T18:00:00.000Z") },
      activeTimers: [],
      feedingWarningMinutes: 120,
      now: new Date("2026-06-19T18:00:00.000Z")
    }).find((warning) => warning.type === "feeding");

    expect(older?.fingerprint).toBeDefined();
    expect(newer?.fingerprint).toBeDefined();
    expect(older?.fingerprint).not.toBe(newer?.fingerprint);
  });

  it("tracks timer warnings independently from feeding and diaper warnings", () => {
    const warnings = buildDashboardWarningItems({
      babyId: "baby-1",
      lastFeeding: { occurredAt: new Date("2026-06-19T18:00:00.000Z") },
      lastDiaper: { occurredAt: new Date("2026-06-19T18:00:00.000Z") },
      activeTimers: [
        {
          id: "timer-1",
          type: "sleep",
          timerState: TimerState.running,
          startedAt: new Date("2026-06-19T10:00:00.000Z")
        }
      ],
      sleepWarningMinutes: 360,
      now: new Date("2026-06-19T18:00:00.000Z")
    });

    expect(warnings).toEqual([
      expect.objectContaining({
        type: "timer",
        message: "Timer running unusually long"
      })
    ]);
  });

  it("resolves a selected dashboard date into the configured timezone range", () => {
    const date = resolveDashboardDate("2026-06-19", "America/New_York");

    expect(date.key).toBe("2026-06-19");
    expect(date.label).toBe("Fri, Jun 19, 2026");
    expect(date.previous).toBe("2026-06-18");
    expect(date.next).toBe("2026-06-20");
    expect(date.start.toISOString()).toBe("2026-06-19T04:00:00.000Z");
    expect(date.end.toISOString()).toBe("2026-06-20T04:00:00.000Z");
  });

  it("falls back to today in the configured timezone for invalid date input", () => {
    const date = resolveDashboardDate("not-a-date", "America/Los_Angeles", new Date("2026-06-19T06:30:00.000Z"));

    expect(date.key).toBe("2026-06-18");
    expect(date.previous).toBe("2026-06-17");
    expect(date.next).toBe("2026-06-19");
  });

  it("adds days to date keys without server timezone drift", () => {
    expect(addDaysToDateKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysToDateKey("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("uses the app timezone by default", () => {
    const date = resolveDashboardDate(undefined, undefined, new Date("2026-06-19T03:30:00.000Z"));

    expect(date.timezone).toBe("America/New_York");
    expect(date.key).toBe("2026-06-18");
  });
});
