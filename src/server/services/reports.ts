import { ActivityType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { activityTypes, type ActivityTypeName } from "@/domain/activity";
import {
  defaultUnitPreferences,
  parseUnitPreferences,
  type UnitPreferences
} from "@/domain/unit-preferences";
import { convertLength, convertWeight, sumVolume } from "@/domain/units";
import { formatDuration } from "@/lib/activity-format";
import { env } from "@/lib/env";
import { buildObservedRoutine, otherRoutineTypes, type RoutineEvent } from "@/lib/observed-routine";
import { addDaysToDateKey, dateKeyInTimeZone, dateTimePartsInTimeZone, zonedDateStart } from "@/lib/timezone";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { getHouseholdHome } from "@/server/services/households";
import { activityInclude } from "@/server/services/activities";

type ReportActivity = Prisma.ActivityLogGetPayload<{ include: typeof activityInclude }>;

export type RoutineWindow = "1w" | "2w" | "1m";

const routineTypes = ["sleep", "feeding", ...otherRoutineTypes] as const;
type RoutineRecord = {
  type: string;
  occurredAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
};

const routineWindows: Record<RoutineWindow, { label: string; days: number }> = {
  "1w": { label: "1 week", days: 7 },
  "2w": { label: "2 weeks", days: 14 },
  "1m": { label: "1 month", days: 30 }
};

export async function getReports(userId: string, input?: { babyId?: string; start?: string; end?: string; routineWindow?: string }) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");
  const home = await getHouseholdHome({ includeInactive: true });
  if (!home) return null;
  const baby = home.household.babies.find((item) => item.id === input?.babyId) ?? home.household.babies[0];
  const todayKey = dateKeyInTimeZone(new Date(), env.APP_TIMEZONE);
  const startKey = isValidDateKey(input?.start) ? input.start : addDaysToDateKey(todayKey, -6);
  const endKey = isValidDateKey(input?.end) ? input.end : todayKey;
  const start = zonedDateStart(startKey, env.APP_TIMEZONE);
  const end = zonedDateStart(endKey, env.APP_TIMEZONE);
  const endExclusive = zonedDateStart(addDaysToDateKey(endKey, 1), env.APP_TIMEZONE);
  const routineWindow = resolveRoutineWindow(input?.routineWindow);
  const routineRange = routineWindowRange(endKey, routineWindow, env.APP_TIMEZONE);
  if (!baby) {
    return {
      home,
      baby: null,
      start,
      end,
      startKey,
      endKey,
      timezone: env.APP_TIMEZONE,
      activities: [],
      routine: buildRoutine([], endKey, routineWindow, env.APP_TIMEZONE),
      stats: null
    };
  }

  const [activities, routineActivities] = await Promise.all([
    prisma.activityLog.findMany({
      where: {
        householdId: ctx.householdId,
        babyId: baby.id,
        deletedAt: null,
        occurredAt: { gte: start, lt: endExclusive }
      },
      include: activityInclude,
      orderBy: { occurredAt: "asc" }
    }),
    prisma.activityLog.findMany({
      where: {
        householdId: ctx.householdId,
        babyId: baby.id,
        deletedAt: null,
        type: { in: [...routineTypes] as ActivityType[] },
        // From the day before, so the first morning in the window has the night that ended it.
        occurredAt: { gte: zonedDateStart(addDaysToDateKey(routineRange.startKey, -1), env.APP_TIMEZONE), lt: routineRange.endExclusive }
      },
      select: { type: true, occurredAt: true, startedAt: true, endedAt: true, durationSeconds: true },
      orderBy: { occurredAt: "asc" }
    })
  ]);

  return {
    home,
    baby,
    start,
    end,
    startKey,
    endKey,
    timezone: env.APP_TIMEZONE,
    activities,
    routine: buildRoutine(routineActivities, endKey, routineWindow, env.APP_TIMEZONE),
    stats: buildReportStats(
      activities,
      baby.birthDate,
      env.APP_TIMEZONE,
      parseUnitPreferences(home.household.settings?.unitPreferences)
    )
  };
}

export function resolveRoutineWindow(value: string | undefined): RoutineWindow {
  return value === "2w" || value === "1m" ? value : "1w";
}

export function routineWindowRange(endKey: string, window: RoutineWindow, timeZone = env.APP_TIMEZONE) {
  const days = routineWindows[window].days;
  const startKey = addDaysToDateKey(endKey, -(days - 1));
  const endExclusiveKey = addDaysToDateKey(endKey, 1);
  return {
    window,
    label: routineWindows[window].label,
    days,
    startKey,
    endKey,
    start: zonedDateStart(startKey, timeZone),
    endExclusive: zonedDateStart(endExclusiveKey, timeZone)
  };
}

export function buildRoutine(records: RoutineRecord[], endKey: string, window: RoutineWindow, timeZone = env.APP_TIMEZONE) {
  const range = routineWindowRange(endKey, window, timeZone);
  return {
    window,
    windowLabel: range.label,
    ...buildObservedRoutine(routineEventsFrom(records), range, timeZone)
  };
}

/**
 * A timed activity runs from its start to its recorded end; one stopped without an end time ends
 * after its recorded length, and one still running has no end yet.
 */
export function routineEventsFrom(records: RoutineRecord[]): RoutineEvent[] {
  return records.map((record) => {
    const start = record.startedAt ?? record.occurredAt;
    const end = record.endedAt ?? (record.durationSeconds === null ? null : new Date(start.getTime() + record.durationSeconds * 1000));
    return { type: record.type, start, end };
  });
}

export type RoutineTimeline = ReturnType<typeof buildRoutine>;

export function buildReportStats(
  activities: ReportActivity[],
  birthDate?: Date | null,
  timeZone = env.APP_TIMEZONE,
  preferences: UnitPreferences = defaultUnitPreferences
) {
  const byType = Object.fromEntries(activityTypes.map((type) => [type, 0])) as Record<ActivityTypeName, number>;
  let sleepSeconds = 0;
  let completedSleepCount = 0;
  let napCount = 0;
  let nightSleepSeconds = 0;
  const bottleVolumes: Array<{ amount: number; unit?: string | null }> = [];
  let bottleCount = 0;
  let breastCount = 0;
  let solidsCount = 0;
  let wet = 0;
  let dirty = 0;
  const pumpingVolumes: Array<{ amount: number; unit?: string | null }> = [];

  const heatmap = Array.from({ length: 7 }, (_, day) =>
    Array.from({ length: 24 }, (_, hour) => ({ day, hour, count: 0 }))
  ).flat();

  const growth: Record<"weight" | "length" | "head", GrowthPoint[] | null> = {
    weight: [],
    length: [],
    head: []
  };

  const milestones: Array<{ date: Date; title: string; category?: string | null }> = [];

  for (const activity of activities) {
    byType[activity.type as ActivityTypeName] += 1;
    const localKey = dateKeyInTimeZone(activity.occurredAt, timeZone);
    const day = dayIndexFromDateKey(localKey);
    const hour = dateTimePartsInTimeZone(activity.occurredAt, timeZone).hour;
    heatmap[day * 24 + hour].count += 1;

    if (activity.type === ActivityType.sleep) {
      const seconds = activity.durationSeconds ?? 0;
      sleepSeconds += seconds;
      if (activity.durationSeconds !== null) completedSleepCount += 1;
      if (activity.sleep?.sleepType === "nap") napCount += 1;
      if (activity.sleep?.sleepType === "night") nightSleepSeconds += seconds;
    }
    if (activity.feeding) {
      if (activity.feeding.mode === "bottle" || activity.feeding.mode === "formula") {
        bottleCount += 1;
        if (activity.feeding.amount !== null && activity.feeding.amount !== undefined) {
          bottleVolumes.push({ amount: Number(activity.feeding.amount), unit: activity.feeding.unit });
        }
      }
      if (activity.feeding.mode === "breast") breastCount += 1;
      if (activity.feeding.mode === "solids") solidsCount += 1;
    }
    if (activity.diaper?.kind === "wet" || activity.diaper?.kind === "mixed") wet += 1;
    if (activity.diaper?.kind === "dirty" || activity.diaper?.kind === "mixed") dirty += 1;
    if (activity.pumping?.amount !== null && activity.pumping?.amount !== undefined) {
      pumpingVolumes.push({ amount: Number(activity.pumping.amount), unit: activity.pumping.unit });
    }
    if (activity.measurement) {
      const date = dateKeyInTimeZone(activity.occurredAt, timeZone);
      const ageMonths = birthDate
        ? Number(((activity.occurredAt.getTime() - birthDate.getTime()) / (1000 * 60 * 60 * 24 * 30.4375)).toFixed(1))
        : 0;
      if (activity.measurement.weight) {
        growth.weight = appendGrowthPoint(
          growth.weight,
          date,
          ageMonths,
          convertWeight(Number(activity.measurement.weight), activity.measurement.weightUnit, preferences.weight),
          preferences.weight
        );
      }
      if (activity.measurement.length) {
        growth.length = appendGrowthPoint(
          growth.length,
          date,
          ageMonths,
          convertLength(Number(activity.measurement.length), activity.measurement.lengthUnit, preferences.length),
          preferences.length
        );
      }
      if (activity.measurement.headCircumference) {
        growth.head = appendGrowthPoint(
          growth.head,
          date,
          ageMonths,
          convertLength(Number(activity.measurement.headCircumference), activity.measurement.headUnit, preferences.length),
          preferences.length
        );
      }
    }
    if (activity.milestone) {
      milestones.push({ date: activity.occurredAt, title: activity.milestone.title, category: activity.milestone.category });
    }
  }

  const bottleTotal = sumVolume(bottleVolumes, preferences.volume).amount;
  const pumped = sumVolume(pumpingVolumes, preferences.volume).amount;

  return {
    byType,
    sleep: {
      total: formatDuration(sleepSeconds) || "0 min",
      average: formatDuration(completedSleepCount ? sleepSeconds / completedSleepCount : 0) || "0 min",
      naps: napCount,
      night: formatDuration(nightSleepSeconds) || "0 min"
    },
    feeding: {
      bottleCount,
      bottleAverage: bottleCount && bottleTotal !== null ? Number((bottleTotal / bottleCount).toFixed(2)) : bottleCount ? null : 0,
      unit: preferences.volume,
      breastCount,
      solidsCount
    },
    diaper: { wet, dirty },
    pumping: { total: pumped === null ? null : Number(pumped.toFixed(2)), unit: preferences.volume },
    growth,
    milestones,
    heatmap
  };
}

type GrowthPoint = { date: string; ageMonths: number; value: number; unit: string };

function appendGrowthPoint(
  points: GrowthPoint[] | null,
  date: string,
  ageMonths: number,
  value: number | null,
  unit: string
) {
  if (points === null || value === null) return null;
  return [...points, { date, ageMonths, value: Number(value.toFixed(2)), unit }];
}

function isValidDateKey(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dayIndexFromDateKey(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

