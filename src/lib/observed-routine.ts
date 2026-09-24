import { activityLabels, type ActivityTypeName } from "@/domain/activity";
import { formatDuration } from "@/lib/activity-format";
import { addDaysToDateKey, dateKeyInTimeZone, dateTimePartsInTimeZone } from "@/lib/timezone";

/**
 * The baby's day as it has actually been happening: when they wake, nap, feed and go to bed, worked
 * out from what was logged over a trailing window. It is observed, never planned - it describes the
 * logs, and says nothing about what should happen.
 *
 * The old version lined entries up by their position in each day ("the second sleep of every day"),
 * so a single extra catnap shifted every later sleep and averaged a nap with a bedtime. Here sleep is
 * first read as wake, naps and bedtime, and a day's naps (or feeds) are averaged position by position
 * only across the days that had the usual number of them. A day with an extra nap is counted as a day
 * with an extra nap, and left out of the times rather than distorting them.
 */

export const ROUTINE_MIN_DAYS = 3;
// A per-position time is shown only when the usual count is really usual; otherwise it is too
// variable to name and the range is shown instead.
const SLOT_MIN_SHARE = 0.4;

const MINUTES_PER_DAY = 24 * 60;
// A sleep that ends between these, having started overnight, is the night ending: that is waking up.
const MORNING_START = 4 * 60;
const MORNING_END = 11 * 60;
const NIGHT_STARTS_BEFORE = 7 * 60;
// The first sleep from late afternoon on that lasts at least an hour (or is still going) is bedtime,
// so a short evening catnap is not mistaken for it.
const BEDTIME_EARLIEST = 17 * 60;
const BEDTIME_MIN_SECONDS = 60 * 60;
// When waking or bedtime was not logged, a day is read as these hours.
const DAY_FALLBACK_START = 5 * 60;
const DAY_FALLBACK_END = 20 * 60;
const NAP_FALLBACK_END = 18 * 60;
// The first feed often comes just before the logged wake-up.
const WAKE_FEED_LEAD = 30;

export const otherRoutineTypes = ["bath", "pumping", "medicine", "supplement", "play"] as const;
export type OtherRoutineType = (typeof otherRoutineTypes)[number];

export type RoutineEvent = { type: string; start: Date; end: Date | null };

export type RoutineSlot = {
  minutes: number;
  time: string;
  /** Typical distance from the usual time, to the nearest 5 minutes. */
  spreadMinutes: number;
  durationSeconds: number | null;
  duration: string | null;
  days: number;
};

export type RoutinePattern = {
  usualCount: number;
  daysWithUsualCount: number;
  daysCounted: number;
  minCount: number;
  maxCount: number;
  slots: RoutineSlot[];
};

export type RoutineTimelineEntry = {
  id: string;
  kind: "wake" | "nap" | "bedtime" | "feed" | OtherRoutineType;
  activityType: ActivityTypeName;
  label: string;
  slot: RoutineSlot;
};

type Local = { key: string; minute: number };
type Occurrence = { minute: number; durationSeconds: number | null };
type Sleep = { start: Date; end: Date | null; s: Local; e: Local | null };

export function buildObservedRoutine(
  events: readonly RoutineEvent[],
  window: { startKey: string; endKey: string; days: number },
  timeZone: string
) {
  // Formatting a time in a zone is the expensive step, and a month of logs repeats few instants.
  const localCache = new Map<number, Local>();
  const local = (date: Date): Local => {
    const cached = localCache.get(date.getTime());
    if (cached) return cached;
    const parts = dateTimePartsInTimeZone(date, timeZone);
    const value = { key: dateKeyInTimeZone(date, timeZone), minute: parts.hour * 60 + parts.minute };
    localCache.set(date.getTime(), value);
    return value;
  };
  const keys = Array.from({ length: window.days }, (_, offset) => addDaysToDateKey(window.startKey, offset));
  const inWindow = new Set(keys);

  const sleeps: Sleep[] = events
    .filter((item) => item.type === "sleep")
    .map((item) => ({ start: item.start, end: item.end, s: local(item.start), e: item.end ? local(item.end) : null }));
  const feeds = events.filter((item) => item.type === "feeding").map((item) => ({ at: item.start, l: local(item.start) }));

  const wakeOn = (key: string) => {
    let latest: Sleep | null = null;
    for (const sleep of sleeps) {
      if (!sleep.e || !sleep.end || sleep.e.key !== key) continue;
      if (sleep.e.minute < MORNING_START || sleep.e.minute >= MORNING_END) continue;
      if (sleep.s.key === key && sleep.s.minute >= NIGHT_STARTS_BEFORE) continue;
      if (!latest || sleep.end > latest.end!) latest = sleep;
    }
    return latest ? { at: latest.end!, minute: latest.e!.minute } : null;
  };
  const bedtimeOn = (key: string) => {
    let earliest: Sleep | null = null;
    for (const sleep of sleeps) {
      if (sleep.s.key !== key || sleep.s.minute < BEDTIME_EARLIEST) continue;
      if (sleep.end && (sleep.end.getTime() - sleep.start.getTime()) / 1000 < BEDTIME_MIN_SECONDS) continue;
      if (!earliest || sleep.start < earliest.start) earliest = sleep;
    }
    return earliest ? { at: earliest.start, minute: earliest.s.minute } : null;
  };

  const wakes = new Map(keys.map((key) => [key, wakeOn(key)]));
  const bedtimes = new Map(keys.map((key) => [key, bedtimeOn(key)]));
  const fullDays = keys.filter((key) => wakes.get(key) && bedtimes.get(key));

  const napsByDay = new Map<string, Occurrence[]>();
  for (const key of keys) {
    const from = wakes.get(key)?.minute ?? DAY_FALLBACK_START;
    const until = bedtimes.get(key)?.minute ?? NAP_FALLBACK_END;
    napsByDay.set(key, sleeps
      .filter((sleep) => sleep.s.key === key && sleep.s.minute >= from && sleep.s.minute < until)
      .map((sleep) => ({ minute: sleep.s.minute, durationSeconds: sleep.end ? (sleep.end.getTime() - sleep.start.getTime()) / 1000 : null }))
      .sort((left, right) => left.minute - right.minute));
  }

  const feedsByDay = new Map<string, Occurrence[]>();
  for (const key of keys) {
    const from = (wakes.get(key)?.minute ?? DAY_FALLBACK_START + WAKE_FEED_LEAD) - WAKE_FEED_LEAD;
    const until = bedtimes.get(key)?.minute ?? DAY_FALLBACK_END;
    feedsByDay.set(key, feeds
      .filter((feed) => feed.l.key === key && feed.l.minute >= from && feed.l.minute < until)
      .map((feed) => ({ minute: feed.l.minute, durationSeconds: null }))
      .sort((left, right) => left.minute - right.minute));
  }

  // A day that was logged from waking to bedtime is the only kind that can say how many naps or feeds
  // there were. Without enough of those, fall back to the days that had any.
  const countedDays = (byDay: Map<string, Occurrence[]>) =>
    fullDays.length >= ROUTINE_MIN_DAYS ? fullDays : keys.filter((key) => (byDay.get(key)?.length ?? 0) > 0);

  const wakeSlot = slotFrom(keys.flatMap((key) => wakes.get(key) ?? []).map(({ minute }) => ({ minute, durationSeconds: null })));
  const bedtimeSlot = slotFrom(keys.flatMap((key) => bedtimes.get(key) ?? []).map(({ minute }) => ({ minute, durationSeconds: null })));

  const nights = keys.flatMap((key) => {
    const next = addDaysToDateKey(key, 1);
    const bed = bedtimes.get(key);
    const wake = inWindow.has(next) ? wakes.get(next) : null;
    return bed && wake ? [{ bed: bed.at, wake: wake.at }] : [];
  });
  const night = nights.length >= ROUTINE_MIN_DAYS
    ? (() => {
        const durationSeconds = average(nights.map(({ bed, wake }) => (wake.getTime() - bed.getTime()) / 1000));
        return { durationSeconds, duration: formatDuration(durationSeconds), nights: nights.length };
      })()
    : null;

  const naps = sleeps.length ? patternFrom(napsByDay, countedDays(napsByDay)) : null;
  const feedPattern = patternFrom(feedsByDay, countedDays(feedsByDay));
  const feedGaps = countedDays(feedsByDay).flatMap((key) => {
    const day = feedsByDay.get(key) ?? [];
    return day.slice(1).map((feed, index) => feed.minute - day[index].minute);
  });
  const intervalMinutes = feedGaps.length ? median(feedGaps) : null;
  const nightFeeds = nights.length >= ROUTINE_MIN_DAYS
    ? { perNight: Math.round(average(nights.map(({ bed, wake }) => feeds.filter((feed) => feed.at >= bed && feed.at < wake).length)) * 2) / 2, nights: nights.length }
    : null;
  const feedsSummary = feedPattern
    ? { ...feedPattern, intervalMinutes, interval: intervalMinutes ? formatDuration(intervalMinutes * 60) : null, nightFeeds }
    : null;

  const others = otherRoutineTypes.flatMap((type) => {
    const byDay = new Map<string, Occurrence[]>();
    for (const item of events) {
      if (item.type !== type) continue;
      const at = local(item.start);
      if (!inWindow.has(at.key)) continue;
      byDay.set(at.key, [...(byDay.get(at.key) ?? []), {
        minute: at.minute,
        durationSeconds: item.end ? (item.end.getTime() - item.start.getTime()) / 1000 : null
      }].sort((left, right) => left.minute - right.minute));
    }
    const daysWithAny = keys.filter((key) => byDay.has(key));
    const pattern = patternFrom(byDay, daysWithAny);
    return pattern ? [{ ...pattern, type, daysWithAny: daysWithAny.length }] : [];
  });

  const timeline: RoutineTimelineEntry[] = [];
  if (wakeSlot) timeline.push({ id: "wake", kind: "wake", activityType: "sleep", label: "Wake up", slot: wakeSlot });
  naps?.slots.forEach((slot, index) => timeline.push({
    id: `nap-${index}`, kind: "nap", activityType: "sleep", label: naps.slots.length === 1 ? "Nap" : `Nap ${index + 1}`, slot
  }));
  feedsSummary?.slots.forEach((slot, index) => timeline.push({ id: `feed-${index}`, kind: "feed", activityType: "feeding", label: "Feed", slot }));
  for (const other of others) {
    other.slots.forEach((slot, index) => timeline.push({ id: `${other.type}-${index}`, kind: other.type, activityType: other.type, label: activityLabels[other.type], slot }));
  }
  // The day reads from waking; bedtime closes it even when it falls after midnight.
  const anchor = wakeSlot?.minutes ?? DAY_FALLBACK_START;
  const fromWake = (minutes: number) => (minutes - anchor + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  timeline.sort((left, right) => fromWake(left.slot.minutes) - fromWake(right.slot.minutes));
  if (bedtimeSlot) timeline.push({ id: "bedtime", kind: "bedtime", activityType: "sleep", label: "Bedtime", slot: bedtimeSlot });

  return {
    startKey: window.startKey,
    endKey: window.endKey,
    windowDays: window.days,
    daysWithData: new Set(events.map((item) => local(item.start).key).filter((key) => inWindow.has(key))).size,
    enoughData: timeline.length > 0,
    wake: wakeSlot,
    bedtime: bedtimeSlot,
    night,
    naps: naps && (naps.maxCount > 0) ? naps : null,
    feeds: feedsSummary,
    others,
    timeline
  };
}

export type ObservedRoutine = ReturnType<typeof buildObservedRoutine>;

function patternFrom(byDay: Map<string, Occurrence[]>, days: string[]): RoutinePattern | null {
  if (days.length < ROUTINE_MIN_DAYS) return null;
  const counts = days.map((key) => byDay.get(key)?.length ?? 0);
  const usualCount = mode(counts);
  const matching = days.filter((key) => (byDay.get(key)?.length ?? 0) === usualCount);
  const pinned = usualCount > 0 && matching.length >= 2 && matching.length / days.length >= SLOT_MIN_SHARE;
  return {
    usualCount,
    daysWithUsualCount: matching.length,
    daysCounted: days.length,
    minCount: Math.min(...counts),
    maxCount: Math.max(...counts),
    slots: pinned
      ? Array.from({ length: usualCount }, (_, index) => slotFrom(matching.map((key) => byDay.get(key)![index]), 2)!)
      : []
  };
}

function slotFrom(occurrences: Occurrence[], minDays = ROUTINE_MIN_DAYS): RoutineSlot | null {
  if (occurrences.length < minDays) return null;
  const minutes = circularMean(occurrences.map((item) => item.minute));
  const spread = average(occurrences.map((item) => circularDistance(item.minute, minutes)));
  const durations = occurrences.flatMap((item) => (item.durationSeconds === null ? [] : [item.durationSeconds]));
  const durationSeconds = durations.length ? average(durations) : null;
  return {
    minutes,
    time: formatMinuteOfDay(minutes),
    spreadMinutes: Math.round(spread / 5) * 5,
    durationSeconds,
    duration: durationSeconds ? formatDuration(durationSeconds) || null : null,
    days: occurrences.length
  };
}

/** The most common count; a tie goes to the larger, so a missed log reads as missing rather than typical. */
function mode(values: number[]) {
  const tally = new Map<number, number>();
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
  return [...tally.entries()].sort((left, right) => right[1] - left[1] || right[0] - left[0])[0][0];
}

function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Clock times averaged on the clock face, so 11:50 PM and 12:10 AM average to midnight, not noon. */
function circularMean(values: number[]) {
  const radians = (2 * Math.PI) / MINUTES_PER_DAY;
  const x = values.reduce((total, value) => total + Math.cos(value * radians), 0);
  const y = values.reduce((total, value) => total + Math.sin(value * radians), 0);
  if (Math.hypot(x, y) < 1e-10) return average(values);
  const angle = Math.atan2(y, x);
  const minutes = ((angle < 0 ? angle + 2 * Math.PI : angle) / (2 * Math.PI)) * MINUTES_PER_DAY;
  return Math.round(minutes) % MINUTES_PER_DAY;
}

function circularDistance(left: number, right: number) {
  const difference = Math.abs(left - right) % MINUTES_PER_DAY;
  return Math.min(difference, MINUTES_PER_DAY - difference);
}

export function formatMinuteOfDay(value: number) {
  const total = Math.round(value);
  const hours24 = Math.floor(total / 60) % 24;
  const minutes = total % 60;
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(minutes).padStart(2, "0")} ${hours24 >= 12 ? "PM" : "AM"}`;
}
