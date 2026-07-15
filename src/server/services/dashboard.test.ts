import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityType, DiaperKind, FeedingKind, TimerState } from "@prisma/client";
import { defaultUnitPreferences } from "@/domain/unit-preferences";
import { SELECTED_BABY_COOKIE } from "@/lib/baby-selector";

const mocks = vi.hoisted(() => ({
  activityFindFirst: vi.fn(),
  activityFindMany: vi.fn(),
  activityGroupBy: vi.fn(),
  cookieGet: vi.fn(),
  dismissalFindMany: vi.fn(),
  getHouseholdHome: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    activityLog: {
      findFirst: mocks.activityFindFirst,
      findMany: mocks.activityFindMany,
      groupBy: mocks.activityGroupBy
    },
    dashboardWarningDismissal: {
      findMany: mocks.dismissalFindMany
    }
  }
}));

vi.mock("@/server/services/households", () => ({
  getHouseholdHome: mocks.getHouseholdHome
}));

vi.mock("next/headers", () => ({
  cookies: () => ({ get: mocks.cookieGet })
}));

import {
  addDaysToDateKey,
  buildDashboardAggregates,
  buildDashboardWarningItems,
  filterDismissedWarnings,
  getDashboard,
  getDashboardPageData,
  resolveDashboardDate,
  summarizeDay
} from "@/server/services/dashboard";

type SummaryActivity = Parameters<typeof summarizeDay>[0][number];

function summaryActivity(input: Partial<SummaryActivity> & { type: ActivityType }): SummaryActivity {
  return {
    type: input.type,
    durationSeconds: input.durationSeconds ?? null,
    feeding: input.feeding ?? null,
    diaper: input.diaper ?? null,
    pumping: input.pumping ?? null
  } as SummaryActivity;
}

function feeding(mode: FeedingKind, amount?: string, unit = "oz") {
  return { mode, amount: amount ?? null, unit } as SummaryActivity["feeding"];
}

function diaper(kind: DiaperKind) {
  return { kind } as SummaryActivity["diaper"];
}

function pumping(amount?: string, unit = "oz") {
  return { amount: amount ?? null, unit } as SummaryActivity["pumping"];
}

function householdHome() {
  return {
    householdId: "household-1",
    household: {
      settings: { unitPreferences: defaultUnitPreferences },
      babies: [
        {
          id: "baby-1",
          name: "Finley",
          birthDate: new Date("2026-03-13T00:00:00.000Z"),
          feedingWarningMinutes: null,
          diaperWarningMinutes: null,
          sleepWarningMinutes: null
        },
        {
          id: "baby-2",
          name: "Riley",
          birthDate: null,
          inactiveAt: null,
          feedingWarningMinutes: null,
          diaperWarningMinutes: null,
          sleepWarningMinutes: null
        }
      ]
    }
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("dashboard service data loading", () => {
  it("uses one selected-day activity collection for the timeline and aggregates", async () => {
    const activities = [
      summaryActivity({ type: ActivityType.feeding, feeding: feeding(FeedingKind.bottle, "4.25") }),
      summaryActivity({ type: ActivityType.note })
    ];
    mocks.getHouseholdHome.mockResolvedValue(householdHome());
    mocks.activityFindMany.mockResolvedValueOnce(activities).mockResolvedValueOnce([]);
    mocks.activityGroupBy.mockResolvedValue([
      { type: ActivityType.feeding, _count: 1 },
      { type: ActivityType.note, _count: 1 }
    ]);
    mocks.activityFindFirst.mockResolvedValue(null);
    mocks.dismissalFindMany.mockResolvedValue([]);

    const dashboard = await getDashboard("user-1", { babyId: "baby-1", date: "2026-06-19" });

    const selectedDayReads = mocks.activityFindMany.mock.calls.filter(([query]) => query.where.occurredAt);
    expect(selectedDayReads).toHaveLength(1);
    expect(mocks.activityGroupBy).not.toHaveBeenCalled();
    expect(dashboard?.activities).toBe(activities);
    expect(dashboard?.dailySummary?.feeding).toEqual({ count: 1, amount: 4.25, unit: "oz" });
    expect(dashboard?.summaries).toEqual({ feeding: 1, note: 1 });
  });

  it("loads dashboard and selector data with one household and active-timer read", async () => {
    const activeTimers = [
      {
        id: "timer-sleep",
        type: ActivityType.sleep,
        timerState: TimerState.running,
        startedAt: new Date("2026-06-19T17:00:00.000Z"),
        createdAt: new Date("2026-06-19T17:00:01.000Z")
      }
    ];
    mocks.cookieGet.mockReturnValue({ value: "baby-1" });
    mocks.getHouseholdHome.mockResolvedValue(householdHome());
    mocks.activityFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce(activeTimers);
    mocks.activityFindFirst.mockResolvedValue(null);
    mocks.dismissalFindMany.mockResolvedValue([]);

    const pageData = await getDashboardPageData("user-1", { babyId: "baby-2", date: "2026-06-19" });

    const activeTimerReads = mocks.activityFindMany.mock.calls.filter(([query]) => query.where.timerState);
    expect(mocks.getHouseholdHome).toHaveBeenCalledTimes(1);
    expect(activeTimerReads).toHaveLength(1);
    expect(activeTimerReads[0][0].orderBy).toEqual([{ startedAt: "desc" }, { createdAt: "desc" }]);
    expect(pageData?.dashboard.baby?.id).toBe("baby-2");
    expect(pageData?.babySelector).toMatchObject({
      selectedBabyId: "baby-2",
      activeTimerType: ActivityType.sleep
    });
  });

  it("falls back to the cached baby and scopes dashboard queries to that baby", async () => {
    mocks.cookieGet.mockImplementation((name) => name === SELECTED_BABY_COOKIE ? { value: "baby-2" } : undefined);
    mocks.getHouseholdHome.mockResolvedValue(householdHome());
    mocks.activityFindMany.mockResolvedValue([]);
    mocks.activityFindFirst.mockResolvedValue(null);
    mocks.dismissalFindMany.mockResolvedValue([]);

    const pageData = await getDashboardPageData("user-1", { babyId: "missing", date: "2026-06-19" });

    const activeTimerRead = mocks.activityFindMany.mock.calls.find(([query]) => query.where.timerState);
    expect(mocks.cookieGet).toHaveBeenCalledWith(SELECTED_BABY_COOKIE);
    expect(pageData?.dashboard.baby?.id).toBe("baby-2");
    expect(pageData?.babySelector?.selectedBabyId).toBe("baby-2");
    expect(activeTimerRead?.[0].where.babyId).toBe("baby-2");
  });

  it("falls back to the first baby when query and cookie selections are invalid", async () => {
    mocks.cookieGet.mockReturnValue({ value: "missing-cookie-baby" });
    mocks.getHouseholdHome.mockResolvedValue(householdHome());
    mocks.activityFindMany.mockResolvedValue([]);
    mocks.activityFindFirst.mockResolvedValue(null);
    mocks.dismissalFindMany.mockResolvedValue([]);

    const pageData = await getDashboardPageData("user-1", { babyId: "missing-query-baby", date: "2026-06-19" });

    const activeTimerRead = mocks.activityFindMany.mock.calls.find(([query]) => query.where.timerState);
    expect(pageData?.dashboard.baby?.id).toBe("baby-1");
    expect(pageData?.babySelector?.selectedBabyId).toBe("baby-1");
    expect(activeTimerRead?.[0].where.babyId).toBe("baby-1");
  });

  it("returns the empty dashboard contract without activity reads when no baby exists", async () => {
    mocks.getHouseholdHome.mockResolvedValue({
      ...householdHome(),
      household: { babies: [] }
    });

    const pageData = await getDashboardPageData("user-1", { date: "2026-06-19" });

    expect(pageData?.dashboard).toMatchObject({
      baby: null,
      activities: [],
      activeTimers: [],
      warnings: [],
      summaries: {}
    });
    expect(pageData?.babySelector).toBeNull();
    expect(mocks.activityFindMany).not.toHaveBeenCalled();
    expect(mocks.activityFindFirst).not.toHaveBeenCalled();
    expect(mocks.activityGroupBy).not.toHaveBeenCalled();
    expect(mocks.dismissalFindMany).not.toHaveBeenCalled();
  });

  it("filters inactive babies out of the active selector and dashboard queries", async () => {
    mocks.cookieGet.mockReturnValue({ value: "baby-2" });
    mocks.getHouseholdHome.mockResolvedValue({
      ...householdHome(),
      household: {
        ...householdHome().household,
        babies: [
          {
            ...householdHome().household.babies[0],
            inactiveAt: null
          },
          {
            ...householdHome().household.babies[1],
            inactiveAt: new Date("2026-07-14T12:00:00.000Z")
          }
        ]
      }
    });
    mocks.activityFindMany.mockResolvedValue([]);
    mocks.activityFindFirst.mockResolvedValue(null);
    mocks.dismissalFindMany.mockResolvedValue([]);

    const pageData = await getDashboardPageData("user-1", { babyId: "baby-2", date: "2026-06-19" });

    expect(pageData?.dashboard.baby?.id).toBe("baby-1");
    expect(pageData?.babySelector?.selectedBabyId).toBe("baby-1");
    expect(pageData?.babySelector?.babies.map((baby) => baby.id)).toEqual(["baby-1"]);
  });

  it("returns an intentional no-active-babies contract when every baby is inactive", async () => {
    mocks.getHouseholdHome.mockResolvedValue({
      ...householdHome(),
      household: {
        ...householdHome().household,
        babies: householdHome().household.babies.map((baby) => ({
          ...baby,
          inactiveAt: new Date("2026-07-14T12:00:00.000Z")
        }))
      }
    });

    const pageData = await getDashboardPageData("user-1", { date: "2026-06-19" });

    expect(pageData?.dashboard).toMatchObject({
      baby: null,
      activities: [],
      activeTimers: [],
      warnings: [],
      summaries: {}
    });
    expect(pageData?.babySelector).toBeNull();
    expect(mocks.activityFindMany).not.toHaveBeenCalled();
  });
});

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

describe("dashboard aggregates", () => {
  it("derives the daily summary and per-type counts from the selected-day activities", () => {
    const activities = [
      summaryActivity({ type: ActivityType.feeding, feeding: feeding(FeedingKind.bottle, "4.25") }),
      summaryActivity({ type: ActivityType.note }),
      summaryActivity({ type: ActivityType.feeding, feeding: feeding(FeedingKind.formula, "2.50") }),
      summaryActivity({ type: ActivityType.sleep, durationSeconds: 1800 })
    ];

    const aggregates = buildDashboardAggregates(activities);

    expect(aggregates.dailySummary.feeding).toEqual({ count: 2, amount: 6.75, unit: "oz" });
    expect(aggregates.dailySummary.sleep).toEqual({ count: 1, seconds: 1800 });
    expect(aggregates.summaries).toEqual({ feeding: 2, note: 1, sleep: 1 });
  });
});

describe("daily summary", () => {
  it("summarizes supported activity groups and ignores unsupported day activity", () => {
    const summary = summarizeDay([
      summaryActivity({ type: ActivityType.sleep, durationSeconds: 1800 }),
      summaryActivity({ type: ActivityType.feeding, feeding: feeding(FeedingKind.breast) }),
      summaryActivity({ type: ActivityType.feeding, feeding: feeding(FeedingKind.bottle, "4.25") }),
      summaryActivity({ type: ActivityType.feeding, feeding: feeding(FeedingKind.formula, "2.50") }),
      summaryActivity({ type: ActivityType.feeding, feeding: feeding(FeedingKind.solids) }),
      summaryActivity({ type: ActivityType.diaper, diaper: diaper(DiaperKind.wet) }),
      summaryActivity({ type: ActivityType.diaper, diaper: diaper(DiaperKind.dirty) }),
      summaryActivity({ type: ActivityType.diaper, diaper: diaper(DiaperKind.mixed) }),
      summaryActivity({ type: ActivityType.diaper, diaper: diaper(DiaperKind.dry) }),
      summaryActivity({ type: ActivityType.pumping, pumping: pumping("3.50") }),
      summaryActivity({ type: ActivityType.bath }),
      summaryActivity({ type: ActivityType.milestone }),
      summaryActivity({ type: ActivityType.medicine }),
      summaryActivity({ type: ActivityType.supplement }),
      summaryActivity({ type: ActivityType.vaccine }),
      summaryActivity({ type: ActivityType.play, durationSeconds: 900 }),
      summaryActivity({ type: ActivityType.note }),
      summaryActivity({ type: ActivityType.mood })
    ]);

    expect(summary.sleep).toEqual({ count: 1, seconds: 1800 });
    expect(summary.feeding).toEqual({ count: 4, amount: 6.75, unit: "oz" });
    expect(summary.diaper).toEqual({ count: 4, wet: 1, dirty: 1, mixed: 1, dry: 1 });
    expect(summary.pumping).toEqual({ count: 1, amount: 3.5, unit: "oz" });
    expect(summary.bath).toEqual({ count: 1 });
    expect(summary.milestone).toEqual({ count: 1 });
    expect(summary.medicine).toEqual({ count: 1 });
    expect(summary.supplement).toEqual({ count: 1 });
    expect(summary.vaccine).toEqual({ count: 1 });
    expect(summary.play).toEqual({ count: 1, seconds: 900 });
  });

  it("returns zero metrics when no supported summary activity was recorded", () => {
    const summary = summarizeDay([
      summaryActivity({ type: ActivityType.note }),
      summaryActivity({ type: ActivityType.measurement }),
      summaryActivity({ type: ActivityType.mood })
    ]);

    expect(summary).toEqual({
      sleep: { count: 0, seconds: 0 },
      feeding: { count: 0, amount: 0, unit: "oz" },
      diaper: { count: 0, wet: 0, dirty: 0, mixed: 0, dry: 0 },
      bath: { count: 0 },
      pumping: { count: 0, amount: 0, unit: "oz" },
      milestone: { count: 0 },
      medicine: { count: 0 },
      supplement: { count: 0 },
      vaccine: { count: 0 },
      play: { count: 0, seconds: 0 }
    });
  });

  it("normalizes mixed volume rows into the household preference", () => {
    const preferences = { ...defaultUnitPreferences, volume: "mL" as const };
    const summary = summarizeDay([
      summaryActivity({ type: ActivityType.feeding, feeding: feeding(FeedingKind.bottle, "1", "oz") }),
      summaryActivity({ type: ActivityType.feeding, feeding: feeding(FeedingKind.formula, "29.5735", "mL") }),
      summaryActivity({ type: ActivityType.pumping, pumping: pumping("2", "oz") }),
      summaryActivity({ type: ActivityType.pumping, pumping: pumping("59.147", "mL") })
    ], preferences);

    expect(summary.feeding).toEqual({ count: 2, amount: expect.closeTo(59.147, 3), unit: "mL" });
    expect(summary.pumping).toEqual({ count: 2, amount: expect.closeTo(118.294, 3), unit: "mL" });
  });

  it("omits an amount instead of silently mixing unsupported explicit units", () => {
    const summary = summarizeDay([
      summaryActivity({ type: ActivityType.feeding, feeding: feeding(FeedingKind.bottle, "1", "oz") }),
      summaryActivity({ type: ActivityType.feeding, feeding: feeding(FeedingKind.formula, "2", "cups") })
    ], defaultUnitPreferences);

    expect(summary.feeding).toEqual({ count: 2, amount: null, unit: "oz" });
  });
});
