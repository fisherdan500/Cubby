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

/** A day far below the week's better-logged days was probably logged by somebody who stopped. */
const COMPLETE_DAY_SHARE = 0.4;

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
  /**
   * Days this measure could not state a figure for, though they were logged. Reporting only the
   * days that worked reads as full coverage of a week that was partly set aside.
   */
  daysUnknown: number;
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
 * The days of a week that were logged thoroughly enough to average.
 *
 * The floor is a share of how the week's BETTER-logged days look, not of its middle day. Anchoring
 * on the median collapses exactly when it is needed most: once the thin days are half the week, the
 * median is itself thin, the floor falls to almost nothing and every sitter day is averaged in. A
 * week of three ordinary days and four single-entry ones then reads as half the real figure while
 * the caption still claims seven days of evidence.
 *
 * The floor is relative rather than a fixed count because feeding and sleeping legitimately halve as
 * a baby grows: "at least four entries" would throw away real days later on and admit junk early on.
 */
export function completeDays(days: TrendDay[]) {
  if (days.length <= 1) return [...days];
  const sorted = [...days].map((day) => day.entries).sort((left, right) => left - right);
  // The median of the upper half: a robust stand-in for "a day that was properly logged", which a
  // minority of thin days cannot drag down.
  const upper = sorted.slice(Math.floor(sorted.length / 2));
  const typical = median(upper);
  const floor = typical * COMPLETE_DAY_SHARE;
  const kept = days.filter((day) => day.entries >= floor);
  // Anchoring high can in principle exclude everything; the best-logged day always belongs.
  return kept.length ? kept : days.filter((day) => day.entries === sorted[sorted.length - 1]);
}

/**
 * The weekly series, in order, blanks included. A blank week is kept in place rather than dropped so
 * a gap reads as a gap on the chart instead of closing silently over the missing time.
 */
export function trendSeries(weeks: TrendWeek[], options?: { measuredShare?: number[] }): TrendPoint[] {
  return weeks.map((week, index) => {
    const logged = week.days.length;
    // Note that a day carried with no figure still counts as evidence of how thoroughly the week
    // was logged, so it takes part in the floor below. That is deliberate - whether a day's bottles
    // could be totalled and whether the day was well logged are separate questions - but it does
    // couple the two rules, so change either with the other in mind.
    const complete = completeDays(week.days);
    const kept = complete.filter((day) => day.value !== null);
    // A day that was well enough logged to count, but whose figure could not be known: a bottle
    // with no amount, or an amount in a unit this cannot read.
    const unknown = complete.length - kept.length;
    const share = options?.measuredShare?.[index];

    const enough = kept.length >= ROUTINE_MIN_DAYS;
    const measured = share === undefined || share >= VOLUME_MIN_MEASURED_SHARE;
    const value =
      enough && measured ? kept.reduce((total, day) => total + (day.value ?? 0), 0) / kept.length : null;

    return { weekKey: week.weekKey, value, daysCounted: kept.length, daysLogged: logged, daysUnknown: unknown };
  });
}
