import { describe, expect, it } from "vitest";
import { TimerState } from "@prisma/client";
import { buildDashboardWarningItems, filterDismissedWarnings } from "@/server/services/dashboard";

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
});
