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

export async function getReports(userId: string, input?: { babyId?: string; start?: string; end?: string }) {
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
      stats: null
    };
  }

  const activities = await prisma.activityLog.findMany({
    where: {
      householdId: ctx.householdId,
      babyId: baby.id,
      deletedAt: null,
      occurredAt: { gte: start, lt: endExclusive }
    },
    include: activityInclude,
    orderBy: { occurredAt: "asc" }
  });

  return {
    home,
    baby,
    start,
    end,
    startKey,
    endKey,
    timezone: env.APP_TIMEZONE,
    activities,
    stats: buildStats(activities, baby.birthDate, env.APP_TIMEZONE)
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
