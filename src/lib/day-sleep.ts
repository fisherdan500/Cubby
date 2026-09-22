/**
 * How much of a day a baby spent asleep, and therefore how much of it they spent awake.
 *
 * The rest of the daily summary counts events by the day they happened on, which is right for feeds
 * and diapers. It is wrong for sleep, because the longest sleep of the day usually starts the evening
 * before: attributed to its start day, an overnight sleep leaves the morning showing no sleep at all.
 * Nobody noticed while sleep was a lone total, but the moment awake time sits beside it the error is
 * plain - at nine in the morning it would read nine hours awake.
 *
 * So sleep is measured as the part of each sleep that overlaps the day, and awake is the part of the
 * day that has actually happened, less that. The two always add up to the day so far.
 */

export type DaySleepRecord = {
  occurredAt: Date | string;
  startedAt: Date | string | null;
  endedAt: Date | string | null;
  durationSeconds: number | null;
  timerState: string;
  pausedAt: Date | string | null;
};

function instant(value: Date | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The wall-clock stretch a sleep covers. A running sleep runs up to now; a paused one stopped
 * accruing when it was paused. A sleep entered by hand carries a duration instead of an end.
 */
export function sleepInterval(record: DaySleepRecord, now: number) {
  const startedAt = instant(record.startedAt) ?? instant(record.occurredAt);
  if (startedAt === null) return null;

  const endedAt = instant(record.endedAt);
  if (endedAt !== null) return { start: startedAt, end: Math.max(startedAt, endedAt) };

  if (record.timerState === "paused") {
    const pausedAt = instant(record.pausedAt);
    if (pausedAt !== null) return { start: startedAt, end: Math.max(startedAt, pausedAt) };
  }
  if (record.timerState === "running" || record.timerState === "paused") {
    return { start: startedAt, end: Math.max(startedAt, now) };
  }

  if (record.durationSeconds !== null) return { start: startedAt, end: startedAt + record.durationSeconds * 1_000 };
  return null;
}

/**
 * Seconds of sleep falling inside the window, and how many sleeps contributed any.
 *
 * A record that was paused is capped at the time it actually recorded as slept, so a long pause in
 * the middle of a nap is not counted as sleep just because the clock kept moving.
 */
export function daySleepSeconds(
  records: readonly DaySleepRecord[],
  windowStart: Date,
  windowEnd: Date,
  now: number
) {
  const from = windowStart.getTime();
  const to = windowEnd.getTime();
  let seconds = 0;
  let count = 0;

  for (const record of records) {
    const interval = sleepInterval(record, now);
    if (!interval) continue;
    const overlap = Math.min(to, interval.end) - Math.max(from, interval.start);
    if (overlap <= 0) continue;
    const overlapSeconds = Math.round(overlap / 1_000);
    const recorded = record.durationSeconds;
    seconds += recorded === null ? overlapSeconds : Math.min(overlapSeconds, recorded);
    count += 1;
  }

  return { seconds, count };
}

/**
 * The part of the day that has happened. A past day is however long it was - 23 or 25 hours across a
 * daylight-saving change, because the window's own instants carry that - and today runs only to now.
 */
export function dayElapsedSeconds(windowStart: Date, windowEnd: Date, now: number) {
  const from = windowStart.getTime();
  const until = Math.min(windowEnd.getTime(), now);
  return Math.max(0, Math.round((until - from) / 1_000));
}

/** The day so far, less the sleep in it. Never negative, however the records are edited. */
export function dayAwakeSeconds(windowStart: Date, windowEnd: Date, now: number, sleepSeconds: number) {
  return Math.max(0, dayElapsedSeconds(windowStart, windowEnd, now) - sleepSeconds);
}
