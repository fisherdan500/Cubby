/**
 * The trend behind the routine: how a baby's sleeping, feeding and changing have moved week by week.
 *
 * The Routine tab answers "what does a usual day look like now" and reads times of day. This answers
 * "what has been changing" and reads totals, so the two need different protection against patchy
 * logging. Routine can take the most common number of naps and ignore the odd day; a total has no
 * such natural filter, so `src/lib/trends.ts` carries the rules that keep these figures honest.
 *
 * Total sleep is measured exactly as the dashboard's Total Sleep card measures it - by how much of each
 * sleep fell inside the day - so a night that runs past midnight is shared between the two days it
 * covers. Any other rule would disagree with the card the household reads every morning.
 */

import { ActivityType, type DiaperKind, type Prisma } from "@prisma/client";
import { daySleepSeconds, sleepInterval, type DaySleepRecord } from "@/lib/day-sleep";
import { convertVolume, sumVolume } from "@/domain/units";
import { addDaysToDateKey, dateKeyInTimeZone, zonedDateStart, zonedDateTimeToDate } from "@/lib/timezone";
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
  feedingUnit?: string | null;
  diaperKind: DiaperKind | null;
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
  daytimeSleep: TrendPanel;
  nighttimeSleep: TrendPanel;
  feeds: TrendPanel;
  volume: TrendPanel;
  diapers: TrendPanel;
  wetDiapers: TrendPanel;
  dirtyDiapers: TrendPanel;
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
// A sleep timer still running after this long was forgotten rather than slept. Two days is past any
// real nap or night while still allowing the longest genuine overnight a timer legitimately spans.
export const UNFINISHED_SLEEP_LIMIT_MS = 2 * 24 * 60 * 60 * 1000;

// An end this can place on a calendar. An unreadable end is an unfinished sleep, not a finished one.
function isReadableEnd(endedAt: Date | null): endedAt is Date {
  return endedAt !== null && Number.isFinite(endedAt.getTime());
}

// The sleep fields of an activity, in the shape the dashboard's own sleep helpers expect.
function asSleepRecord(activity: TrendActivity): DaySleepRecord {
  return {
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
}

type DayFeeds = { count: number; pourable: number; volumes: Array<{ amount: number; unit?: string | null }> };

// Every amount on the day this can convert to ounces. The one place that decides what "known" means.
function readableOunces(feeds: DayFeeds) {
  return feeds.volumes
    .map((entry) => convertVolume(entry.amount, entry.unit, "oz"))
    .filter((ounces): ounces is number => ounces !== null);
}

// A day's intake in ounces, or null when it cannot be stated honestly.
//
// Four rounds of defects in this panel all had one shape: a feed whose volume was not known got
// replaced by the average of the feeds that were, and the chart reported an intake nobody recorded.
// A day of one 4oz bottle beside nine in tablespoons read as 40oz when it may have held 13. So the
// rule here is flat: every poured feed must carry an amount this can read, or the day is not
// reported. An estimate is indistinguishable from a measurement once it is drawn as a line, and the
// household reads this chart to decide whether a baby is feeding enough.
function knownVolumeOunces(feeds: DayFeeds) {
  if (feeds.pourable === 0) return null;
  const readable = readableOunces(feeds);
  if (readable.length !== feeds.pourable) return null;
  return readable.reduce((total, ounces) => total + ounces, 0);
}

export function buildTrends(activities: TrendActivity[], options: {
  timeZone: string;
  now: number;
  window?: { from: Date; to: Date };
}): Trends {
  const { timeZone, now, window } = options;
  const from = window?.from.getTime() ?? -Infinity;
  const to = window?.to.getTime() ?? Infinity;
  // Naming the day an instant falls on means formatting it in the household's zone, which is the
  // expensive step here: five years of logs repeat few distinct instants, and a month of them repeat
  // almost none. The observed routine caches this for the same reason.
  const keyCache = new Map<number, string>();
  const keyOf = (date: Date) => {
    const at = date.getTime();
    const cached = keyCache.get(at);
    if (cached !== undefined) return cached;
    const key = dateKeyInTimeZone(date, timeZone);
    keyCache.set(at, key);
    return key;
  };
  const startCache = new Map<string, Date>();
  const startOf = (key: string) => {
    const cached = startCache.get(key);
    if (cached) return cached;
    const start = zonedDateStart(key, timeZone);
    startCache.set(key, start);
    return start;
  };
  // Today is still happening, so its totals are not comparable with whole days: a morning's three
  // feeds against yesterday's six reads as a drop that is only the clock. It joins once it is over.
  const todayKey = keyOf(new Date(now));
  const firstWindowKey = window ? keyOf(window.from) : null;
  const dayKeys = new Set<string>();
  const sleepsByDay = new Map<string, DaySleepRecord[]>();
  // `count` is every feed, for the feeds panel. The volume fields cover only the feeds this panel
  // is about: a breastfeed has no amount to measure and no bottle volume to contribute.
  const feedsByDay = new Map<string, {
    count: number;
    pourable: number;
    volumes: Array<{ amount: number; unit?: string | null }>;
  }>();
  const diapersByDay = new Map<string, { count: number; wet: number; dirty: number; known: boolean }>();

  for (const activity of activities) {
    // One unreadable timestamp is one row's problem. Letting it reach the zone formatter threw
    // RangeError out of the whole page, so a single bad row took the Reports tab down with it.
    if (!Number.isFinite(activity.occurredAt?.getTime?.() ?? Number.NaN)) continue;
    // Leave a forgotten timer out before anything else sees it, including the day it was filed
    // under: an excluded sleep must not stretch the chart either. One timer left running since
    // April opened the window in April and drew nine empty weeks ahead of the real data.
    // Asked of every sleep row, not only those with no end at all: an end that cannot be read is
    // just as unfinished as an absent one, and both arrive here claiming days they never covered.
    if (activity.type === ActivityType.sleep) {
      const span = sleepInterval(asSleepRecord(activity), now);
      if (!isReadableEnd(activity.endedAt)) {
        if (!span || !Number.isFinite(span.end - span.start)) continue;
        if (span.end - span.start > UNFINISHED_SLEEP_LIMIT_MS) continue;
      }
    } else if (activity.occurredAt.getTime() < from || activity.occurredAt.getTime() >= to) {
      continue;
    }
    const key = keyOf(activity.occurredAt);
    // With a resolved window, sleep contributes only the canonical interval's covered days below.
    if (!window || activity.type !== ActivityType.sleep) dayKeys.add(key);

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
      // Every day a sleep covers must exist as a day, not just the one it began on and the one it
      // ended on: a sleep running over thirty hours has a middle day that is entirely asleep, and
      // leaving it out drops a full day of sleep from the week.
      if (!window && isReadableEnd(activity.endedAt)) {
        const endKey = keyOf(activity.endedAt);
        for (let covered = key; covered <= endKey; covered = addDaysToDateKey(covered, 1)) {
          dayKeys.add(covered);
        }
      }
      continue;
    }

    if (activity.type === ActivityType.feeding) {
      const amount = amountOf(activity.feedingAmount);
      const current = feedsByDay.get(key) ?? { count: 0, pourable: 0, volumes: [] };
      current.count += 1;
      // Bottle and formula: the feeds that are poured from a container, named positively because
      // FeedingKind also holds solids, and a puree at dinner is not a bottle. reports.ts asks the
      // same question the same way.
      if (activity.feedingMode === "bottle" || activity.feedingMode === "formula") {
        current.pourable += 1;
        if (amount !== null) current.volumes.push({ amount, unit: activity.feedingUnit ?? null });
      }
      feedsByDay.set(key, current);
      continue;
    }

    if (activity.type === ActivityType.diaper) {
      const current = diapersByDay.get(key) ?? { count: 0, wet: 0, dirty: 0, known: true };
      current.count += 1;
      if (activity.diaperKind === "wet" || activity.diaperKind === "mixed") current.wet += 1;
      if (activity.diaperKind === "dirty" || activity.diaperKind === "mixed") current.dirty += 1;
      if (activity.diaperKind == null) current.known = false;
      diapersByDay.set(key, current);
    }
  }

  // Sleep is selected by whether it OVERLAPS the day, exactly as the dashboard does, rather than by
  // which day it was filed under. A fixed one-day lookback silently truncated two real cases: the
  // first day of any window never received the tail of the night that ended it, so two identical
  // weeks rendered as a slope; and a sleep spanning more than two days was invisible to its third
  // day onwards, so a mistaken thirty-hour entry lost most of itself without a word.
  // Each sleep is filed once against every day it touches, rather than every day re-scanning every
  // sleep: at a five-year window that difference is seconds of server time per page view.
  const dayBounds = new Map<string, { start: Date; end: Date }>();
  const boundsOf = (key: string) => {
    const cached = dayBounds.get(key);
    if (cached) return cached;
    const bounds = { start: startOf(key), end: startOf(addDaysToDateKey(key, 1)) };
    dayBounds.set(key, bounds);
    return bounds;
  };

  const overlapping = new Map<string, DaySleepRecord[]>();
  const reportingBounds = new Map<string, { start: Date; middle: Date; end: Date }>();
  const reportingBoundsOf = (key: string) => {
    const cached = reportingBounds.get(key);
    if (cached) return cached;
    const bounds = {
      start: zonedDateTimeToDate(`${key}T07:00`, timeZone),
      middle: zonedDateTimeToDate(`${key}T19:00`, timeZone),
      end: zonedDateTimeToDate(`${addDaysToDateKey(key, 1)}T07:00`, timeZone)
    };
    reportingBounds.set(key, bounds);
    return bounds;
  };
  const reportingKeyOf = (at: number) => {
    const key = keyOf(new Date(at));
    return at < reportingBoundsOf(key).start.getTime() ? addDaysToDateKey(key, -1) : key;
  };
  const reportingSleeps = new Map<string, DaySleepRecord[]>();
  for (const [, records] of sleepsByDay) {
    for (const record of records) {
      const span = sleepInterval(record, now);
      if (!span) continue;
      const start = Math.max(span.start, from);
      const end = Math.min(span.end, to);
      const firstKey = keyOf(new Date(start));
      const lastKey = keyOf(new Date(window ? end - 1 : end));
      for (let covered = firstKey; covered <= lastKey; covered = addDaysToDateKey(covered, 1)) {
        if (window) dayKeys.add(covered);
        const bucket = overlapping.get(covered);
        if (bucket) bucket.push(record);
        else overlapping.set(covered, [record]);
      }
      // Index only reporting days the interval actually touches; an end at 7 AM belongs to
      // the preceding night. Each day then scans its own records, not the full history.
      if (end <= start) continue;
      const reportKey = reportingKeyOf(start);
      // Reporting dates, like calendar dates, stay inside the selected local date range.
      const firstReportKey = firstWindowKey && reportKey < firstWindowKey ? firstWindowKey : reportKey;
      const lastReportKey = reportingKeyOf(end - 1);
      for (let covered = firstReportKey; covered <= lastReportKey; covered = addDaysToDateKey(covered, 1)) {
        const bucket = reportingSleeps.get(covered);
        if (bucket) bucket.push(record);
        else reportingSleeps.set(covered, [record]);
      }
    }
  }

  const keys = [...dayKeys].filter((key) => key < todayKey).sort();
  const weeks = bucketWeeks(keys, timeZone);

  // Both halves become comparable only once their entire 7 AM-to-7 AM day is over.
  const splitKeys = [...reportingSleeps.keys()].filter((key) => {
    const { start, end } = reportingBoundsOf(key);
    return end.getTime() <= now && (!window || (start.getTime() >= from && end.getTime() <= to));
  });
  const splitWeeks = bucketWeeks(splitKeys, timeZone);
  const splitSleepWeeks = (half: "daytime" | "nighttime") => splitWeeks.map((week) => ({
    weekKey: week.weekKey,
    days: week.dayKeys.map((key): TrendDay => {
      const records = reportingSleeps.get(key)!;
      const { start, middle, end } = reportingBoundsOf(key);
      const slept = daySleepSeconds(records, half === "daytime" ? start : middle, half === "daytime" ? middle : end, now);
      return { key, entries: records.length, value: slept.seconds };
    })
  }));

  const sleepSecondsFor = (key: string) => {
    const records = overlapping.get(key);
    if (!records?.length) return null;
    const { start, end } = boundsOf(key);
    const slept = daySleepSeconds(records, start, end, now);
    return slept.count > 0 ? slept.seconds : null;
  };

  // A day's evidence is how many sleeps actually overlapped it, not how many were filed under it: a
  // morning that holds only the tail of last night was logged just as well as any other.
  const sleepEntriesFor = (key: string) => overlapping.get(key)?.length ?? 0;

  const sleepWeeks = weeks.map((week) => ({
    weekKey: week.weekKey,
    days: week.dayKeys.flatMap((key): TrendDay[] => {
      const seconds = sleepSecondsFor(key);
      if (seconds === null) return [];
      return [{ key, entries: sleepEntriesFor(key), value: seconds }];
    })
  }));

  const feedWeeks = weeks.map((week) => ({
    weekKey: week.weekKey,
    days: week.dayKeys.flatMap((key): TrendDay[] => {
      const feeds = feedsByDay.get(key);
      return feeds ? [{ key, entries: feeds.count, value: feeds.count }] : [];
    })
  }));

  // A day's volume is weighed by the feeds that were actually measured. Counting an unmeasured feed
  // as nought ounces while still carrying its day at full weight under-reported intake by as much as
  // a tenth in a week that still passed the guard below - the wrong direction on an intake chart.
  const volumeWeeks = weeks.map((week) => ({
    weekKey: week.weekKey,
    days: week.dayKeys.flatMap((key): TrendDay[] => {
      const feeds = feedsByDay.get(key);
      if (!feeds || feeds.pourable === 0) return [];
      // A day whose bottles could not be totalled is still carried, with no figure. Dropping it
      // here would leave the caption counting only the days that worked, which reads as full
      // coverage of a week that was partly set aside.
      return [{ key, entries: feeds.count, value: knownVolumeOunces(feeds) }];
    })
  }));

  // What share of the week's POURED feeds this can actually total. A week where bottles went
  // unrecorded, or were recorded in something this cannot convert, cannot be averaged honestly and
  // is left blank rather than guessed at. Breastfeeds are not in this denominator: they never carry
  // an amount, and counting them blanked a well-measured bottle week for also breastfeeding.
  const measuredShare = weeks.map((week) => {
    let pourable = 0;
    let known = 0;
    for (const key of week.dayKeys) {
      const feeds = feedsByDay.get(key);
      if (!feeds) continue;
      pourable += feeds.pourable;
      known += readableOunces(feeds).length;
    }
    return pourable === 0 ? 0 : known / pourable;
  });

  const diaperWeeks = (measure: "count" | "wet" | "dirty") => weeks.map((week) => ({
    weekKey: week.weekKey,
    days: week.dayKeys.flatMap((key): TrendDay[] => {
      const changes = diapersByDay.get(key);
      // All changes are completeness evidence, including days with zero of this subtype.
      return changes === undefined ? [] : [{
        key,
        entries: changes.count,
        value: measure === "count" || changes.known ? changes[measure] : null
      }];
    })
  }));

  const completedKeys = [...new Set([...keys, ...splitKeys])].sort();

  return {
    startKey: completedKeys[0] ?? "",
    endKey: completedKeys[completedKeys.length - 1] ?? "",
    weeks: bucketWeeks(completedKeys, timeZone).length,
    anyData: completedKeys.length > 0,
    sleep: panel(trendSeries(sleepWeeks)),
    daytimeSleep: panel(trendSeries(splitSleepWeeks("daytime"))),
    nighttimeSleep: panel(trendSeries(splitSleepWeeks("nighttime"))),
    feeds: panel(trendSeries(feedWeeks)),
    volume: panel(trendSeries(volumeWeeks, { measuredShare })),
    diapers: panel(trendSeries(diaperWeeks("count"))),
    wetDiapers: panel(trendSeries(diaperWeeks("wet"))),
    dirtyDiapers: panel(trendSeries(diaperWeeks("dirty")))
  };
}

export { VOLUME_MIN_MEASURED_SHARE };
