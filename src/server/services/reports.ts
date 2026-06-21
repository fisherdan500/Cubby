import { ActivityType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { activityTypes, type ActivityTypeName } from "@/domain/activity";
import { formatDuration } from "@/lib/activity-format";
import { env } from "@/lib/env";
import { addDaysToDateKey, dateKeyInTimeZone, dateTimePartsInTimeZone, zonedDateStart } from "@/lib/timezone";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { getHouseholdHome } from "@/server/services/households";
import { activityInclude } from "@/server/services/activities";

type ReportActivity = Prisma.ActivityLogGetPayload<{ include: typeof activityInclude }>;

export type RoutineWindow = "1w" | "2w" | "1m";

type RoutineActivity = Pick<ReportActivity, "type" | "occurredAt" | "durationSeconds">;

const routineWindows: Record<RoutineWindow, { label: string; days: number }> = {
  "1w": { label: "1 week", days: 7 },
  "2w": { label: "2 weeks", days: 14 },
  "1m": { label: "1 month", days: 30 }
};

export async function getReports(userId: string, input?: { babyId?: string; start?: string; end?: string; routineWindow?: string }) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "activity.read");
  const home = await getHouseholdHome(userId);
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
      routine: buildRoutineTimeline([], endKey, routineWindow, env.APP_TIMEZONE),
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
        type: { in: [ActivityType.sleep, ActivityType.feeding] },
        occurredAt: { gte: routineRange.start, lt: routineRange.endExclusive }
      },
      include: activityInclude,
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
    routine: buildRoutineTimeline(routineActivities, endKey, routineWindow, env.APP_TIMEZONE),
    stats: buildStats(activities, baby.birthDate, env.APP_TIMEZONE)
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

export function buildRoutineTimeline(activities: RoutineActivity[], endKey: string, window: RoutineWindow, timeZone = env.APP_TIMEZONE) {
  const range = routineWindowRange(endKey, window, timeZone);
  const days = new Map<string, Array<{ type: "sleep" | "feeding"; occurredAt: Date; durationSeconds: number | null }>>();
  const sleepMinutes: number[] = [];
  const feedMinutes: number[] = [];
  const sleepDurations: number[] = [];

  for (const activity of activities) {
    if (activity.type !== ActivityType.sleep && activity.type !== ActivityType.feeding) continue;
    const key = dateKeyInTimeZone(activity.occurredAt, timeZone);
    if (key < range.startKey || key > range.endKey) continue;
    const type = activity.type === ActivityType.sleep ? "sleep" : "feeding";
    const minute = minuteOfDay(activity.occurredAt, timeZone);
    if (type === "sleep") {
      sleepMinutes.push(minute);
      if (activity.durationSeconds) sleepDurations.push(activity.durationSeconds);
    } else {
      feedMinutes.push(minute);
    }
    days.set(key, [
      ...(days.get(key) ?? []),
      {
        type,
        occurredAt: activity.occurredAt,
        durationSeconds: activity.durationSeconds ?? null
      }
    ]);
  }

  const sequences = [...days.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entries]) => entries.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime()));
  const daysWithData = sequences.length;
  const minSamples = daysWithData <= 2 ? 1 : Math.max(2, Math.ceil(daysWithData * 0.25));
  const maxLength = Math.max(0, ...sequences.map((sequence) => sequence.length));
  const rows = [];

  for (let index = 0; index < maxLength; index += 1) {
    const entries = sequences.map((sequence) => sequence[index]).filter(Boolean);
    const sleepEntries = entries.filter((entry) => entry.type === "sleep");
    const feedEntries = entries.filter((entry) => entry.type === "feeding");
    const type = sleepEntries.length >= feedEntries.length ? "sleep" : "feeding";
    const matching = type === "sleep" ? sleepEntries : feedEntries;
    if (matching.length < minSamples) continue;

    const averageMinutes = average(matching.map((entry) => minuteOfDay(entry.occurredAt, timeZone)));
    const averageDurationSeconds =
      type === "sleep" ? average(matching.map((entry) => entry.durationSeconds ?? 0).filter((value) => value > 0)) : 0;

    rows.push({
      index,
      type,
      averageMinutes,
      averageTime: formatMinuteOfDay(averageMinutes),
      averageDurationSeconds,
      averageDuration: type === "sleep" ? formatDuration(averageDurationSeconds) || "0 min" : null,
      sampleCount: matching.length
    });
  }

  rows.sort((left, right) => left.averageMinutes - right.averageMinutes);

  return {
    window,
    windowLabel: range.label,
    startKey: range.startKey,
    endKey: range.endKey,
    windowDays: range.days,
    daysWithData,
    minSamples,
    summary: {
      averageSleepTime: sleepMinutes.length ? formatMinuteOfDay(average(sleepMinutes)) : null,
      averageSleepDuration: sleepDurations.length ? formatDuration(average(sleepDurations)) || "0 min" : "0 min",
      averageFeedTime: feedMinutes.length ? formatMinuteOfDay(average(feedMinutes)) : null,
      sleepSamples: sleepMinutes.length,
      feedSamples: feedMinutes.length
    },
    rows
  };
}

function buildStats(activities: ReportActivity[], birthDate?: Date | null, timeZone = env.APP_TIMEZONE) {
  const byType = Object.fromEntries(activityTypes.map((type) => [type, 0])) as Record<ActivityTypeName, number>;
  let sleepSeconds = 0;
  let napCount = 0;
  let nightSleepSeconds = 0;
  let bottleTotal = 0;
  let bottleCount = 0;
  let breastCount = 0;
  let solidsCount = 0;
  let wet = 0;
  let dirty = 0;
  let pumped = 0;

  const heatmap = Array.from({ length: 7 }, (_, day) =>
    Array.from({ length: 24 }, (_, hour) => ({ day, hour, count: 0 }))
  ).flat();

  const growth = {
    weight: [] as Array<{ date: string; ageMonths: number; value: number; unit: string }>,
    length: [] as Array<{ date: string; ageMonths: number; value: number; unit: string }>,
    head: [] as Array<{ date: string; ageMonths: number; value: number; unit: string }>
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
      if (activity.sleep?.sleepType === "nap") napCount += 1;
      if (activity.sleep?.sleepType === "night") nightSleepSeconds += seconds;
    }
    if (activity.feeding) {
      if (activity.feeding.mode === "bottle" || activity.feeding.mode === "formula") {
        bottleCount += 1;
        bottleTotal += Number(activity.feeding.amount ?? 0);
      }
      if (activity.feeding.mode === "breast") breastCount += 1;
      if (activity.feeding.mode === "solids") solidsCount += 1;
    }
    if (activity.diaper?.kind === "wet" || activity.diaper?.kind === "mixed") wet += 1;
    if (activity.diaper?.kind === "dirty" || activity.diaper?.kind === "mixed") dirty += 1;
    if (activity.pumping?.amount) pumped += Number(activity.pumping.amount);
    if (activity.measurement) {
      const date = dateKeyInTimeZone(activity.occurredAt, timeZone);
      const ageMonths = birthDate
        ? Number(((activity.occurredAt.getTime() - birthDate.getTime()) / (1000 * 60 * 60 * 24 * 30.4375)).toFixed(1))
        : 0;
      if (activity.measurement.weight) {
        growth.weight.push({ date, ageMonths, value: Number(activity.measurement.weight), unit: activity.measurement.weightUnit ?? "lb" });
      }
      if (activity.measurement.length) {
        growth.length.push({ date, ageMonths, value: Number(activity.measurement.length), unit: activity.measurement.lengthUnit ?? "in" });
      }
      if (activity.measurement.headCircumference) {
        growth.head.push({ date, ageMonths, value: Number(activity.measurement.headCircumference), unit: activity.measurement.headUnit ?? "in" });
      }
    }
    if (activity.milestone) {
      milestones.push({ date: activity.occurredAt, title: activity.milestone.title, category: activity.milestone.category });
    }
  }

  return {
    byType,
    sleep: {
      total: formatDuration(sleepSeconds) || "0 min",
      average: formatDuration(activities.length ? sleepSeconds / Math.max(1, byType.sleep) : 0) || "0 min",
      naps: napCount,
      night: formatDuration(nightSleepSeconds) || "0 min"
    },
    feeding: {
      bottleCount,
      bottleAverage: bottleCount ? Number((bottleTotal / bottleCount).toFixed(2)) : 0,
      breastCount,
      solidsCount
    },
    diaper: { wet, dirty },
    pumping: { total: Number(pumped.toFixed(2)) },
    growth,
    milestones,
    heatmap
  };
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

function minuteOfDay(date: Date, timeZone: string) {
  const parts = dateTimePartsInTimeZone(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function formatMinuteOfDay(value: number) {
  const total = Math.round(value);
  const hours24 = Math.floor(total / 60) % 24;
  const minutes = total % 60;
  const hours12 = hours24 % 12 || 12;
  const suffix = hours24 >= 12 ? "PM" : "AM";
  return `${hours12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}
