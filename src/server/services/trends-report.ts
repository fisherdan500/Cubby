/**
 * Reading one baby's trends from the database.
 *
 * Kept apart from `getReports` because a trend reads a much longer stretch of history than the other
 * tabs do: it is only worth paying for when the Trends tab is actually open.
 */

import { ActivityType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { addDaysToDateKey, dateKeyInTimeZone, zonedDateStart } from "@/lib/timezone";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { buildTrends, type Trends } from "@/server/services/trends";

export type TrendWindow = "8w" | "6m" | "all";

const windowDays: Record<Exclude<TrendWindow, "all">, number> = {
  "8w": 8 * 7,
  "6m": 183
};

export function resolveTrendWindow(value: string | undefined): TrendWindow {
  return value === "8w" || value === "all" ? value : "6m";
}

/**
 * The trends for one baby over the chosen stretch. The caller has already resolved which baby, so
 * this only enforces that the viewer may read this household's activities at all.
 */
export async function getTrends(babyId: string, window: TrendWindow): Promise<Trends> {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");

  const timeZone = env.APP_TIMEZONE;
  const todayKey = dateKeyInTimeZone(new Date(), timeZone);
  // "All" still has a floor: five years is beyond any household's history here, and an unbounded
  // query is how a reports page becomes the slowest screen in the app.
  const days = window === "all" ? 5 * 365 : windowDays[window];
  const startKey = addDaysToDateKey(todayKey, -(days - 1));
  // A sleep that began before the window can still fill part of its first morning. Two days of
  // lookback rather than one: a single day misses an entry that spans more than twenty-four hours,
  // which is a mistake somebody can make with a timer left running.
  const from = zonedDateStart(addDaysToDateKey(startKey, -2), timeZone);
  const to = zonedDateStart(addDaysToDateKey(todayKey, 1), timeZone);

  const activities = await prisma.activityLog.findMany({
    where: {
      householdId: ctx.householdId,
      babyId,
      deletedAt: null,
      type: { in: [ActivityType.sleep, ActivityType.feeding, ActivityType.diaper] },
      occurredAt: { gte: from, lt: to }
    },
    select: {
      type: true,
      occurredAt: true,
      startedAt: true,
      endedAt: true,
      durationSeconds: true,
      timerState: true,
      pausedAt: true,
      pausedSeconds: true,
      pauseTrackingStartedAt: true,
      pauseTrackingBaselineSeconds: true,
      pauseIntervals: { select: { startedAt: true, endedAt: true } },
      feeding: { select: { amount: true, mode: true } }
    },
    orderBy: { occurredAt: "asc" }
  });

  return buildTrends(
    activities.map((activity) => ({
      type: activity.type,
      occurredAt: activity.occurredAt,
      startedAt: activity.startedAt,
      endedAt: activity.endedAt,
      durationSeconds: activity.durationSeconds,
      timerState: activity.timerState,
      pausedAt: activity.pausedAt,
      pausedSeconds: activity.pausedSeconds ?? undefined,
      pauseTrackingStartedAt: activity.pauseTrackingStartedAt,
      pauseTrackingBaselineSeconds: activity.pauseTrackingBaselineSeconds,
      pauseIntervals: activity.pauseIntervals,
      feedingAmount: activity.feeding?.amount ?? null,
      feedingMode: activity.feeding?.mode ?? null
    })),
    { timeZone, now: Date.now() }
  );
}
