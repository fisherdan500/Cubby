import { ActivityType, DiaperKind, TimerState, type Prisma } from "@prisma/client";
import { cookies } from "next/headers";
import { z } from "zod";
import type { ActivityTypeName } from "@/domain/activity";
import {
  defaultUnitPreferences,
  parseUnitPreferences,
  type UnitPreferences
} from "@/domain/unit-preferences";
import { sumVolume } from "@/domain/units";
import {
  SELECTED_BABY_COOKIE,
  buildHeaderBabySelectorData,
  resolveSelectedBaby
} from "@/lib/baby-selector";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { addDaysToDateKey, dateKeyInTimeZone, normalizeTimeZone, zonedDateStart } from "@/lib/timezone";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { getHouseholdHome } from "@/server/services/households";
import { activityInclude } from "@/server/services/activities";

export { addDaysToDateKey } from "@/lib/timezone";

const warningTypes = ["feeding", "diaper", "timer"] as const;

export type DashboardWarningType = (typeof warningTypes)[number];

export type DashboardWarningItem = {
  type: DashboardWarningType;
  babyId: string;
  message: string;
  fingerprint: string;
};

const dismissWarningSchema = z.object({
  babyId: z.string().min(1),
  type: z.enum(warningTypes),
  fingerprint: z.string().min(1).max(500)
});

export type DashboardDate = {
  key: string;
  label: string;
  previous: string;
  next: string;
  start: Date;
  end: Date;
  timezone: string;
};

type DashboardParams = string | { babyId?: string; date?: string };
type HouseholdHome = NonNullable<Awaited<ReturnType<typeof getHouseholdHome>>>;

export async function getDashboard(userId: string, params?: DashboardParams) {
  const home = await getHouseholdHome(userId);
  if (!home) return null;
  return getDashboardForHome(home, params);
}

export async function getDashboardPageData(
  userId: string,
  params?: { babyId?: string; date?: string }
) {
  const home = await getHouseholdHome(userId);
  if (!home) return null;

  const activeBabies = home.household.babies.filter((baby) => !baby.inactiveAt);
  const cachedBabyId = cookies().get(SELECTED_BABY_COOKIE)?.value;
  const selectedBaby = resolveSelectedBaby(activeBabies, params?.babyId, cachedBabyId);
  const dashboard = await getDashboardForHome(home, { babyId: selectedBaby?.id, date: params?.date });
  const babySelector = dashboard.baby
    ? buildHeaderBabySelectorData(
        activeBabies,
        dashboard.baby.id,
        dashboard.activeTimers[0]?.type as ActivityTypeName | undefined
      )
    : null;

  return { dashboard, babySelector };
}

async function getDashboardForHome(home: HouseholdHome, params?: DashboardParams) {
  const babyId = typeof params === "string" ? params : params?.babyId;
  const dateInput = typeof params === "string" ? undefined : params?.date;
  const activeBabies = home.household.babies.filter((item) => !item.inactiveAt);
  const baby = activeBabies.find((item) => item.id === babyId) ?? activeBabies[0];
  if (!baby) return { home, baby: null, activities: [], activeTimers: [], warnings: [], summaries: {} };

  const selectedDate = resolveDashboardDate(dateInput);

  const [activities, activeTimers, lastFeeding, lastDiaper, lastSleep] = await Promise.all([
    prisma.activityLog.findMany({
      where: {
        householdId: home.householdId,
        babyId: baby.id,
        deletedAt: null,
        occurredAt: { gte: selectedDate.start, lt: selectedDate.end }
      },
      include: activityInclude,
      orderBy: { occurredAt: "desc" }
    }),
    prisma.activityLog.findMany({
      where: {
        householdId: home.householdId,
        babyId: baby.id,
        deletedAt: null,
        timerState: { in: [TimerState.running, TimerState.paused] }
      },
      include: activityInclude,
      orderBy: [{ startedAt: "desc" }, { createdAt: "desc" }]
    }),
    prisma.activityLog.findFirst({
      where: { householdId: home.householdId, babyId: baby.id, deletedAt: null, type: ActivityType.feeding },
      include: activityInclude,
      orderBy: { occurredAt: "desc" }
    }),
    prisma.activityLog.findFirst({
      where: { householdId: home.householdId, babyId: baby.id, deletedAt: null, type: ActivityType.diaper },
      include: activityInclude,
      orderBy: { occurredAt: "desc" }
    }),
    prisma.activityLog.findFirst({
      where: { householdId: home.householdId, babyId: baby.id, deletedAt: null, type: ActivityType.sleep },
      include: activityInclude,
      orderBy: { occurredAt: "desc" }
    })
  ]);

  const warningItems = buildDashboardWarningItems({
    babyId: baby.id,
    lastFeeding,
    lastDiaper,
    activeTimers,
    feedingWarningMinutes: baby.feedingWarningMinutes,
    diaperWarningMinutes: baby.diaperWarningMinutes,
    sleepWarningMinutes: baby.sleepWarningMinutes
  });
  const dismissals = warningItems.length
    ? await prisma.dashboardWarningDismissal.findMany({
        where: {
          householdId: home.householdId,
          babyId: baby.id,
          OR: warningItems.map((warning) => ({
            type: warning.type,
            fingerprint: warning.fingerprint
          }))
        },
        select: { type: true, fingerprint: true }
      })
    : [];
  const dismissed = dismissalKeySet(dismissals);
  const aggregates = buildDashboardAggregates(
    activities,
    parseUnitPreferences(home.household.settings?.unitPreferences)
  );

  return {
    home,
    baby,
    activities,
    activeTimers,
    lastFeeding,
    lastDiaper,
    lastSleep,
    selectedDate,
    warnings: warningItems.filter((warning) => !dismissed.has(dismissalKey(warning))),
    dailySummary: aggregates.dailySummary,
    summaries: aggregates.summaries
  };
}

export function warningState(input: {
  lastFeeding?: { occurredAt: Date } | null;
  lastDiaper?: { occurredAt: Date } | null;
  activeTimers: Array<{ startedAt: Date | null; type: string }>;
  feedingWarningMinutes?: number | null;
  diaperWarningMinutes?: number | null;
  sleepWarningMinutes?: number | null;
}) {
  const now = Date.now();
  const feedingMinutes = input.feedingWarningMinutes ?? 4 * 60;
  const diaperMinutes = input.diaperWarningMinutes ?? 4 * 60;
  const sleepMinutes = input.sleepWarningMinutes ?? 6 * 60;
  return {
    feedingLate: !input.lastFeeding || now - input.lastFeeding.occurredAt.getTime() > feedingMinutes * 60 * 1000,
    diaperLate: !input.lastDiaper || now - input.lastDiaper.occurredAt.getTime() > diaperMinutes * 60 * 1000,
    timerLong: input.activeTimers.some(
      (timer) => timer.startedAt && now - timer.startedAt.getTime() > sleepMinutes * 60 * 1000
    )
  };
}

export function buildDashboardWarningItems(input: {
  babyId: string;
  lastFeeding?: { occurredAt: Date } | null;
  lastDiaper?: { occurredAt: Date } | null;
  activeTimers: Array<{ id: string; startedAt: Date | null; timerState: TimerState | string; type: string }>;
  feedingWarningMinutes?: number | null;
  diaperWarningMinutes?: number | null;
  sleepWarningMinutes?: number | null;
  now?: Date;
}): DashboardWarningItem[] {
  const now = input.now?.getTime() ?? Date.now();
  const feedingMinutes = input.feedingWarningMinutes ?? 4 * 60;
  const diaperMinutes = input.diaperWarningMinutes ?? 4 * 60;
  const sleepMinutes = input.sleepWarningMinutes ?? 6 * 60;
  const items: DashboardWarningItem[] = [];

  if (!input.lastFeeding || now - input.lastFeeding.occurredAt.getTime() > feedingMinutes * 60 * 1000) {
    items.push({
      type: "feeding",
      babyId: input.babyId,
      message: "Long time since feeding",
      fingerprint: warningFingerprint(input.babyId, "feeding", input.lastFeeding?.occurredAt.toISOString() ?? "never")
    });
  }

  if (!input.lastDiaper || now - input.lastDiaper.occurredAt.getTime() > diaperMinutes * 60 * 1000) {
    items.push({
      type: "diaper",
      babyId: input.babyId,
      message: "Long time since diaper",
      fingerprint: warningFingerprint(input.babyId, "diaper", input.lastDiaper?.occurredAt.toISOString() ?? "never")
    });
  }

  const longTimers = input.activeTimers
    .filter((timer) => timer.startedAt && now - timer.startedAt.getTime() > sleepMinutes * 60 * 1000)
    .map((timer) => `${timer.id}:${timer.timerState}:${timer.startedAt?.toISOString()}`)
    .sort();
  if (longTimers.length) {
    items.push({
      type: "timer",
      babyId: input.babyId,
      message: "Timer running unusually long",
      fingerprint: warningFingerprint(input.babyId, "timer", longTimers.join("|"))
    });
  }

  return items;
}

export function filterDismissedWarnings(
  warnings: DashboardWarningItem[],
  dismissals: Array<{ type: string; fingerprint: string }>
) {
  const dismissed = dismissalKeySet(dismissals);
  return warnings.filter((warning) => !dismissed.has(dismissalKey(warning)));
}

export async function dismissDashboardWarning(raw: unknown) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "activity.read");
  const input = dismissWarningSchema.parse(raw);
  const baby = await prisma.baby.findFirst({
    where: { id: input.babyId, householdId: ctx.householdId, deletedAt: null },
    select: { id: true }
  });
  if (!baby) throw new Error("not_found");

  return prisma.dashboardWarningDismissal.upsert({
    where: {
      householdId_babyId_type_fingerprint: {
        householdId: ctx.householdId,
        babyId: input.babyId,
        type: input.type,
        fingerprint: input.fingerprint
      }
    },
    update: {
      dismissedByMemberId: ctx.memberId,
      dismissedAt: new Date()
    },
    create: {
      householdId: ctx.householdId,
      babyId: input.babyId,
      type: input.type,
      fingerprint: input.fingerprint,
      dismissedByMemberId: ctx.memberId
    }
  });
}

function warningFingerprint(babyId: string, type: DashboardWarningType, value: string) {
  return `${babyId}:${type}:${value}`;
}

function dismissalKey(warning: { type: string; fingerprint: string }) {
  return `${warning.type}:${warning.fingerprint}`;
}

function dismissalKeySet(dismissals: Array<{ type: string; fingerprint: string }>) {
  return new Set(dismissals.map(dismissalKey));
}

export function resolveDashboardDate(input: string | undefined, timezone = env.APP_TIMEZONE, now = new Date()): DashboardDate {
  const safeTimezone = normalizeTimeZone(timezone, env.APP_TIMEZONE);
  const key = isValidDateKey(input) ? input : dateKeyInTimeZone(now, safeTimezone);
  const previous = addDaysToDateKey(key, -1);
  const next = addDaysToDateKey(key, 1);
  return {
    key,
    label: formatDashboardDateLabel(key, safeTimezone),
    previous,
    next,
    start: zonedDateStart(key, safeTimezone),
    end: zonedDateStart(next, safeTimezone),
    timezone: safeTimezone
  };
}

function isValidDateKey(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatDashboardDateLabel(key: string, timezone: string) {
  const start = zonedDateStart(key, timezone);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: timezone
  }).format(start);
}

type DashboardActivity = Prisma.ActivityLogGetPayload<{ include: typeof activityInclude }>;

export function buildDashboardAggregates(
  activities: DashboardActivity[],
  preferences: UnitPreferences = defaultUnitPreferences
) {
  const summaries: Partial<Record<ActivityType, number>> = {};
  for (const activity of activities) {
    summaries[activity.type] = (summaries[activity.type] ?? 0) + 1;
  }

  return {
    dailySummary: summarizeDay(activities, preferences),
    summaries
  };
}

export function summarizeDay(
  activities: DashboardActivity[],
  preferences: UnitPreferences = defaultUnitPreferences
) {
  const feedingVolumes: Array<{ amount: number; unit?: string | null }> = [];
  const pumpingVolumes: Array<{ amount: number; unit?: string | null }> = [];
  const summary = {
    sleep: {
      count: 0,
      seconds: 0
    },
    feeding: {
      count: 0,
      amount: 0 as number | null,
      unit: preferences.volume
    },
    diaper: {
      count: 0,
      wet: 0,
      dirty: 0,
      mixed: 0,
      dry: 0
    },
    bath: {
      count: 0
    },
    pumping: {
      count: 0,
      amount: 0 as number | null,
      unit: preferences.volume
    },
    milestone: {
      count: 0
    },
    medicine: {
      count: 0
    },
    supplement: {
      count: 0
    },
    vaccine: {
      count: 0
    },
    play: {
      count: 0,
      seconds: 0
    }
  };

  for (const activity of activities) {
    if (activity.type === ActivityType.sleep) {
      summary.sleep.count += 1;
      summary.sleep.seconds += activity.durationSeconds ?? 0;
    }

    if (activity.type === ActivityType.feeding) {
      summary.feeding.count += 1;
      if (activity.feeding?.amount !== null && activity.feeding?.amount !== undefined) {
        feedingVolumes.push({ amount: Number(activity.feeding.amount), unit: activity.feeding.unit });
      }
    }

    if (activity.type === ActivityType.diaper) {
      summary.diaper.count += 1;
      if (activity.diaper?.kind === DiaperKind.wet) summary.diaper.wet += 1;
      if (activity.diaper?.kind === DiaperKind.dirty) summary.diaper.dirty += 1;
      if (activity.diaper?.kind === DiaperKind.mixed) summary.diaper.mixed += 1;
      if (activity.diaper?.kind === DiaperKind.dry) summary.diaper.dry += 1;
    }

    if (activity.type === ActivityType.bath) summary.bath.count += 1;

    if (activity.type === ActivityType.pumping) {
      summary.pumping.count += 1;
      if (activity.pumping?.amount !== null && activity.pumping?.amount !== undefined) {
        pumpingVolumes.push({ amount: Number(activity.pumping.amount), unit: activity.pumping.unit });
      }
    }

    if (activity.type === ActivityType.milestone) summary.milestone.count += 1;
    if (activity.type === ActivityType.medicine) summary.medicine.count += 1;
    if (activity.type === ActivityType.supplement) summary.supplement.count += 1;
    if (activity.type === ActivityType.vaccine) summary.vaccine.count += 1;

    if (activity.type === ActivityType.play) {
      summary.play.count += 1;
      summary.play.seconds += activity.durationSeconds ?? 0;
    }
  }

  summary.feeding.amount = sumVolume(feedingVolumes, preferences.volume).amount;
  summary.pumping.amount = sumVolume(pumpingVolumes, preferences.volume).amount;

  return summary;
}
