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
  // "All" still has a floor. Two years rather than five: a weekly chart of a hundred-odd points is
  // already more than can be read at once, and the work of placing every entry in the household's
  // own zone is what makes this page slow. Five years of a busy household took six seconds of server
  // time to lay out, for a chart nobody could take in.
  const days = window === "all" ? 2 * 365 : windowDays[window];
  const startKey = addDaysToDateKey(todayKey, -(days - 1));
  const from = zonedDateStart(startKey, timeZone);
  const to = zonedDateStart(addDaysToDateKey(todayKey, 1), timeZone);

  const activities = await prisma.activityLog.findMany({
    where: {
      householdId: ctx.householdId,
      babyId,
      deletedAt: null,
      OR: [
        // Feeds and changes happen at an instant, so they belong to the window by when they happened.
        { type: { in: [ActivityType.feeding, ActivityType.diaper] }, occurredAt: { gte: from, lt: to } },
        // A sleep belongs to the window if it OVERLAPS it, however long before it began. The same
        // rule the dashboard uses: any fixed lookback is arbitrary, and a timer left running for
        // days would silently lose whatever fell outside it.
        {
          type: ActivityType.sleep,
          occurredAt: { lt: to },
          OR: [{ endedAt: { gt: from } }, { endedAt: null }]
        }
      ]
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
      feeding: { select: { amount: true, mode: true, unit: true } }
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
      feedingMode: activity.feeding?.mode ?? null,
      feedingUnit: activity.feeding?.unit ?? null
    })),
    { timeZone, now: Date.now() }
  );
}
