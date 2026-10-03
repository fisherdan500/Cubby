/**
 * The trend behind the routine: how much a baby slept, fed and needed changing, week by week.
 *
 * Routine answers "what does a usual day look like now". This answers "what has been changing", so
 * everything here is a weekly figure per day rather than a position in the day.
 *
 * Two kinds of missing data would otherwise make a trend lie, and both are guarded here:
 *
 * A day nobody logged says nothing about the baby, so it is not in the data at all and never enters
 * an average. The harder case is the day somebody logged ONCE - a sitter who recorded a single feed
 * and no more. That day looks logged, passes every "has entries" check, and drags the week down by
 * an amount that was never real. So a day far below its own week's median is set aside, and the
 * count of days actually used is reported alongside every figure.
 *
 * The second kind is a measurement that only exists for part of the history. Breastfeeds carry no
 * volume - they cannot - so summing ounces across a month of breastfeeding would show almost nothing
 * and then a cliff when the household moved to bottles, implying the baby suddenly ate three times
 * as much. A volume week is only reported when nearly every feed in it was actually measured.
 */

import { addDaysToDateKey, dateKeyInTimeZone } from "@/lib/timezone";
import { ROUTINE_MIN_DAYS } from "@/lib/observed-routine";

/** A day far below its own week's median was probably logged by somebody who stopped. */
const COMPLETE_DAY_MEDIAN_SHARE = 0.4;

/** Nearly every feed in a week must carry a volume before the week's ounces mean anything. */
export const VOLUME_MIN_MEASURED_SHARE = 0.9;

export type TrendDay = {
  key: string;
  /** How many entries of this kind the day has: the evidence that the day was really logged. */
  entries: number;
  /** The day's figure - a count, a duration in seconds, or a volume. Null when it cannot be known. */
  value: number | null;
};

export type TrendWeek = { weekKey: string; days: TrendDay[] };

export type TrendPoint = {
  weekKey: string;
  /** The week's figure per complete day, or null when the week cannot honestly report one. */
  value: number | null;
  /** Days whose figure was used. */
  daysCounted: number;
  /** Days that had any entry at all, complete or not. */
  daysLogged: number;
};

/**
 * The Monday that starts a day's week, in the household's zone. Weeks are the unit because a single
 * day of a baby's life is mostly noise: one bad night moves a daily line and means nothing.
 */
export function weekKeyOf(dayKey: string, timeZone: string) {
  // Midday avoids any chance of a zone offset moving the date under us.
  const at = new Date(`${dayKey}T12:00:00Z`);
  const weekday = new Date(`${dateKeyInTimeZone(at, timeZone)}T12:00:00Z`).getUTCDay();
  // getUTCDay is 0 for Sunday; a week runs Monday to Sunday.
  const back = weekday === 0 ? 6 : weekday - 1;
  return addDaysToDateKey(dayKey, -back);
}

export function bucketWeeks(dayKeys: string[], timeZone: string) {
  const sorted = [...dayKeys].sort();
  if (!sorted.length) return [];

  const byWeek = new Map<string, string[]>();
  for (const key of sorted) {
    const weekKey = weekKeyOf(key, timeZone);
    const bucket = byWeek.get(weekKey);
    if (bucket) bucket.push(key);
    else byWeek.set(weekKey, [key]);
  }

  // Walk from the first week to the last so a week nobody logged stays in the series as an empty
  // one. Dropping it would close the gap silently and draw a line straight across the missing time,
  // which reads as though nothing happened rather than as though nothing is known.
  const weeks: Array<{ weekKey: string; dayKeys: string[] }> = [];
  const lastWeek = weekKeyOf(sorted[sorted.length - 1], timeZone);
  let weekKey = weekKeyOf(sorted[0], timeZone);
  while (weekKey <= lastWeek) {
    weeks.push({ weekKey, dayKeys: byWeek.get(weekKey) ?? [] });
    weekKey = addDaysToDateKey(weekKey, 7);
  }
  return weeks;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The days of a week that were logged thoroughly enough to average. The floor is relative to the
 * week itself because feeding and sleeping legitimately halve as a baby grows: a fixed "at least
 * four entries" would throw away real days later on and admit junk days early on.
 */
export function completeDays(days: TrendDay[]) {
  if (days.length <= 1) return [...days];
  const floor = median(days.map((day) => day.entries)) * COMPLETE_DAY_MEDIAN_SHARE;
  // The median itself always clears a floor set below it, so this can never empty the week.
  return days.filter((day) => day.entries >= floor);
}

/**
 * The weekly series, in order, blanks included. A blank week is kept in place rather than dropped so
 * a gap reads as a gap on the chart instead of closing silently over the missing time.
 */
export function trendSeries(weeks: TrendWeek[], options?: { measuredShare?: number[] }): TrendPoint[] {
  return weeks.map((week, index) => {
    const logged = week.days.length;
    const kept = completeDays(week.days).filter((day) => day.value !== null);
    const share = options?.measuredShare?.[index];

    const enough = kept.length >= ROUTINE_MIN_DAYS;
    const measured = share === undefined || share >= VOLUME_MIN_MEASURED_SHARE;
    const value =
      enough && measured ? kept.reduce((total, day) => total + (day.value ?? 0), 0) / kept.length : null;

    return { weekKey: week.weekKey, value, daysCounted: kept.length, daysLogged: logged };
  });
}
