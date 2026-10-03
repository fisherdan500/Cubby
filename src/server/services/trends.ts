/**
 * The trend behind the routine: how a baby's sleeping, feeding and changing have moved week by week.
 *
 * The Routine tab answers "what does a usual day look like now" and reads times of day. This answers
 * "what has been changing" and reads totals, so the two need different protection against patchy
 * logging. Routine can take the most common number of naps and ignore the odd day; a total has no
 * such natural filter, so `src/lib/trends.ts` carries the rules that keep these figures honest.
 *
 * Sleep is measured exactly as the dashboard's Total Sleep card measures it - by how much of each
 * sleep fell inside the day - so a night that runs past midnight is shared between the two days it
 * covers. Any other rule would disagree with the card the household reads every morning.
 */

import { ActivityType, type Prisma } from "@prisma/client";
import { daySleepSeconds, type DaySleepRecord } from "@/lib/day-sleep";
import { addDaysToDateKey, dateKeyInTimeZone, zonedDateStart } from "@/lib/timezone";
import { bucketWeeks, trendSeries, VOLUME_MIN_MEASURED_SHARE, type TrendDay, type TrendPoint } from "@/lib/trends";

export type { TrendPoint };

/** Only what a trend needs: no names, no notes, no photos. */
export type TrendActivity = {
  type: ActivityType | string;
  occurredAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  timerState: string;
  pausedAt: Date | null;
  pausedSeconds?: number;
  pauseTrackingStartedAt?: Date | null;
  pauseTrackingBaselineSeconds?: number | null;
  pauseIntervals?: ReadonlyArray<{ startedAt: Date; endedAt: Date | null }>;
  feedingAmount: Prisma.Decimal | number | null;
  feedingMode: string | null;
};

export type TrendPanel = {
  points: TrendPoint[];
  /** Days that carried a usable figure, across the whole window. */
  daysCounted: number;
};

export type Trends = {
  startKey: string;
  endKey: string;
  weeks: number;
  anyData: boolean;
  sleep: TrendPanel;
  feeds: TrendPanel;
  volume: TrendPanel;
  diapers: TrendPanel;
};

function amountOf(value: Prisma.Decimal | number | null) {
  if (value === null || value === undefined) return null;
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function panel(points: TrendPoint[]): TrendPanel {
  return { points, daysCounted: points.reduce((total, point) => total + point.daysCounted, 0) };
}

/**
 * Weekly figures for one baby. `now` bounds a day that has not finished yet, exactly as the
 * dashboard does, so today never reads as a collapse simply because it is still morning.
 */
export function buildTrends(activities: TrendActivity[], options: { timeZone: string; now: number }): Trends {
  const { timeZone, now } = options;
  const dayKeys = new Set<string>();
  const sleepsByDay = new Map<string, DaySleepRecord[]>();
  const feedsByDay = new Map<string, { count: number; measured: number; volume: number }>();
  const diapersByDay = new Map<string, number>();

  for (const activity of activities) {
    const key = dateKeyInTimeZone(activity.occurredAt, timeZone);
    dayKeys.add(key);

    if (activity.type === ActivityType.sleep) {
      // A sleep is filed under the day it began, then split by overlap below: a night that runs past
      // midnight belongs partly to each day, which is what the dashboard's cards already show.
      const existing = sleepsByDay.get(key);
      const record: DaySleepRecord = {
        occurredAt: activity.occurredAt,
        startedAt: activity.startedAt,
        endedAt: activity.endedAt,
        durationSeconds: activity.durationSeconds,
        timerState: activity.timerState,
        pausedAt: activity.pausedAt,
        pausedSeconds: activity.pausedSeconds,
        pauseTrackingStartedAt: activity.pauseTrackingStartedAt,
        pauseTrackingBaselineSeconds: activity.pauseTrackingBaselineSeconds,
        pauseIntervals: activity.pauseIntervals
      };
      if (existing) existing.push(record);
      else sleepsByDay.set(key, [record]);
      // A night that began yesterday still fills part of today, so today must exist as a day.
      if (activity.endedAt) dayKeys.add(dateKeyInTimeZone(activity.endedAt, timeZone));
      continue;
    }

    if (activity.type === ActivityType.feeding) {
      const amount = amountOf(activity.feedingAmount);
      const current = feedsByDay.get(key) ?? { count: 0, measured: 0, volume: 0 };
      current.count += 1;
      if (amount !== null) {
        current.measured += 1;
        current.volume += amount;
      }
      feedsByDay.set(key, current);
      continue;
    }

    if (activity.type === ActivityType.diaper) {
      diapersByDay.set(key, (diapersByDay.get(key) ?? 0) + 1);
    }
  }

  const keys = [...dayKeys].sort();
  if (!keys.length) {
    const empty = panel([]);
    return { startKey: "", endKey: "", weeks: 0, anyData: false, sleep: empty, feeds: empty, volume: empty, diapers: empty };
  }

  const weeks = bucketWeeks(keys, timeZone);

  // Sleep needs every sleep that could overlap a day, including one that began the evening before.
  const sleepSecondsFor = (key: string) => {
    const previous = addDaysToDateKey(key, -1);
    const records = [...(sleepsByDay.get(previous) ?? []), ...(sleepsByDay.get(key) ?? [])];
    if (!records.length) return null;
    const windowStart = zonedDateStart(key, timeZone);
    const windowEnd = zonedDateStart(addDaysToDateKey(key, 1), timeZone);
    const slept = daySleepSeconds(records, windowStart, windowEnd, now);
    return slept.count > 0 ? slept.seconds : null;
  };

  const sleepWeeks = weeks.map((week) => ({
    weekKey: week.weekKey,
    days: week.dayKeys.flatMap((key): TrendDay[] => {
      const seconds = sleepSecondsFor(key);
      if (seconds === null) return [];
      return [{ key, entries: (sleepsByDay.get(key) ?? []).length || 1, value: seconds }];
    })
  }));

  const feedWeeks = weeks.map((week) => ({
    weekKey: week.weekKey,
    days: week.dayKeys.flatMap((key): TrendDay[] => {
      const feeds = feedsByDay.get(key);
      return feeds ? [{ key, entries: feeds.count, value: feeds.count }] : [];
    })
  }));

  const volumeWeeks = weeks.map((week) => ({
    weekKey: week.weekKey,
    days: week.dayKeys.flatMap((key): TrendDay[] => {
      const feeds = feedsByDay.get(key);
      return feeds ? [{ key, entries: feeds.count, value: feeds.volume }] : [];
    })
  }));

  // What share of the week's feeds carried a volume at all. Breastfeeds never do, so a week of
  // breastfeeding would otherwise report a few ounces a day and read as near-starvation.
  const measuredShare = weeks.map((week) => {
    let count = 0;
    let measured = 0;
    for (const key of week.dayKeys) {
      const feeds = feedsByDay.get(key);
      if (!feeds) continue;
      count += feeds.count;
      measured += feeds.measured;
    }
    return count === 0 ? 0 : measured / count;
  });

  const diaperWeeks = weeks.map((week) => ({
    weekKey: week.weekKey,
    days: week.dayKeys.flatMap((key): TrendDay[] => {
      const changes = diapersByDay.get(key);
      return changes === undefined ? [] : [{ key, entries: changes, value: changes }];
    })
  }));

  return {
    startKey: keys[0],
    endKey: keys[keys.length - 1],
    weeks: weeks.length,
    anyData: true,
    sleep: panel(trendSeries(sleepWeeks)),
    feeds: panel(trendSeries(feedWeeks)),
    volume: panel(trendSeries(volumeWeeks, { measuredShare })),
    diapers: panel(trendSeries(diaperWeeks))
  };
}

export { VOLUME_MIN_MEASURED_SHARE };
