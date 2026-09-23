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
  pausedSeconds?: number;
  pauseTrackingStartedAt?: Date | string | null;
  pauseTrackingBaselineSeconds?: number | null;
  pauseIntervals?: ReadonlyArray<{
    startedAt: Date | string;
    endedAt: Date | string | null;
  }>;
};

function instant(value: Date | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function second(ms: number) {
  return Math.round(ms / 1_000);
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
  const from = second(windowStart.getTime());
  const to = second(Math.min(windowEnd.getTime(), now));
  if (to <= from) return { seconds: 0, count: 0 };
  let count = 0;
  let hasUnallocatedLegacyPause = false;
  let hasUnknownDurationPosition = false;
  const segments: Array<{ start: number; end: number }> = [];
  const aggregateOnly: Array<{
    start: number;
    end: number;
    seconds: number;
    boundaryUncertaintySeconds: number;
    reason: "legacy_pause_allocation" | "duration_position_unknown";
  }> = [];

  for (const record of records) {
    const rawInterval = sleepInterval(record, now);
    if (!rawInterval) continue;
    const interval = { start: second(rawInterval.start), end: second(rawInterval.end) };
    const overlapStart = Math.max(from, interval.start);
    const overlapEnd = Math.min(to, interval.end);
    const overlap = overlapEnd - overlapStart;
    if (overlap <= 0) continue;
    count += 1;

    const wallSeconds = interval.end - interval.start;
    const rawPauseTrackingStartedAt = instant(record.pauseTrackingStartedAt);
    const pauseTrackingStartedAt = rawPauseTrackingStartedAt === null ? null : second(rawPauseTrackingStartedAt);
    const pauseTrackingBaselineSeconds = record.pauseTrackingBaselineSeconds ?? 0;
    let aggregateReason: "legacy_pause_allocation" | "duration_position_unknown" | null = null;
    if (
      (pauseTrackingStartedAt === null && (record.pausedSeconds ?? 0) > 0) ||
      (pauseTrackingStartedAt !== null && overlapStart < pauseTrackingStartedAt && pauseTrackingBaselineSeconds > 0)
    ) {
      aggregateReason = "legacy_pause_allocation";
    } else if (
      pauseTrackingStartedAt === null &&
      record.durationSeconds !== null &&
      record.durationSeconds !== wallSeconds
    ) {
      aggregateReason = "duration_position_unknown";
    }
    if (aggregateReason !== null) {
      const activeSeconds = record.durationSeconds === null
        ? Math.max(0, wallSeconds - (record.pausedSeconds ?? 0))
        : Math.max(0, record.durationSeconds);
      const boundaryUncertaintySeconds = Math.max(0, activeSeconds - wallSeconds);
      if (
        interval.start - boundaryUncertaintySeconds < from ||
        interval.end + boundaryUncertaintySeconds > to
      ) {
        if (aggregateReason === "legacy_pause_allocation") hasUnallocatedLegacyPause = true;
        else hasUnknownDurationPosition = true;
        continue;
      }
      aggregateOnly.push({
        start: interval.start,
        end: interval.end,
        seconds: activeSeconds,
        boundaryUncertaintySeconds,
        reason: aggregateReason
      });
      continue;
    }

    if (
      pauseTrackingStartedAt !== null &&
      (overlapStart >= pauseTrackingStartedAt || pauseTrackingBaselineSeconds === 0)
    ) {
      segments.push(...subtractPauses({ start: overlapStart, end: overlapEnd }, record.pauseIntervals ?? [], second(now)));
      continue;
    }

    const overlapSeconds = overlap;
    const recorded = record.durationSeconds;
    const contributionSeconds = recorded === null ? overlapSeconds : Math.min(overlapSeconds, recorded);
    segments.push({ start: overlapStart, end: overlapStart + contributionSeconds });
  }

  if (hasUnallocatedLegacyPause) return { seconds: null, count, unavailableReason: "legacy_pause_allocation" as const };
  if (hasUnknownDurationPosition) return { seconds: null, count, unavailableReason: "duration_position_unknown" as const };
  const aggregateOverlap = aggregateOnly.some((aggregate, index) => {
    const uncertainEnvelope = {
      start: aggregate.start - aggregate.boundaryUncertaintySeconds,
      end: aggregate.end + aggregate.boundaryUncertaintySeconds
    };
    return segments.some((segment) => segmentsOverlap(uncertainEnvelope, segment)) ||
      aggregateOnly.some((other, otherIndex) => otherIndex !== index && segmentsOverlap(uncertainEnvelope, {
        start: other.start - other.boundaryUncertaintySeconds,
        end: other.end + other.boundaryUncertaintySeconds
      }));
  });
  if (aggregateOverlap) {
    const unavailableReason = aggregateOnly.some((aggregate) => aggregate.reason === "legacy_pause_allocation")
      ? "legacy_pause_allocation" as const
      : "duration_position_unknown" as const;
    return { seconds: null, count, unavailableReason };
  }
  return {
    seconds: unionMilliseconds(segments) + aggregateOnly.reduce((total, aggregate) => total + aggregate.seconds, 0),
    count
  };
}

function segmentsOverlap(left: { start: number; end: number }, right: { start: number; end: number }) {
  return left.start < right.end && right.start < left.end;
}

function subtractPauses(
  active: { start: number; end: number },
  pauses: NonNullable<DaySleepRecord["pauseIntervals"]>,
  now: number
) {
  const clippedPauses = pauses.flatMap((pause) => {
    const rawStart = instant(pause.startedAt);
    const rawEndedAt = instant(pause.endedAt);
    if (rawStart === null) return [];
    const start = second(rawStart);
    const endedAt = rawEndedAt === null ? now : second(rawEndedAt);
    if (endedAt <= active.start || start >= active.end) return [];
    return [{ start: Math.max(active.start, start), end: Math.min(active.end, Math.max(start, endedAt)) }];
  });
  const mergedPauses = mergeSegments(clippedPauses);
  const result: Array<{ start: number; end: number }> = [];
  let cursor = active.start;
  for (const pause of mergedPauses) {
    if (pause.start > cursor) result.push({ start: cursor, end: pause.start });
    cursor = Math.max(cursor, pause.end);
  }
  if (cursor < active.end) result.push({ start: cursor, end: active.end });
  return result;
}

function mergeSegments(segments: Array<{ start: number; end: number }>) {
  const sorted = segments.filter((segment) => segment.end > segment.start).sort((left, right) => left.start - right.start);
  if (sorted.length === 0) return [];
  const merged = [{ ...sorted[0] }];
  for (const segment of sorted.slice(1)) {
    const current = merged[merged.length - 1];
    if (segment.start <= current.end) current.end = Math.max(current.end, segment.end);
    else merged.push({ ...segment });
  }
  return merged;
}

function unionMilliseconds(segments: Array<{ start: number; end: number }>) {
  const sorted = mergeSegments(segments);
  if (sorted.length === 0) return 0;

  let total = 0;
  let currentStart = sorted[0].start;
  let currentEnd = sorted[0].end;
  for (const segment of sorted.slice(1)) {
    if (segment.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, segment.end);
      continue;
    }
    total += currentEnd - currentStart;
    currentStart = segment.start;
    currentEnd = segment.end;
  }
  return total + currentEnd - currentStart;
}

/**
 * The part of the day that has happened. A past day is however long it was - 23 or 25 hours across a
 * daylight-saving change, because the window's own instants carry that - and today runs only to now.
 */
export function dayElapsedSeconds(windowStart: Date, windowEnd: Date, now: number) {
  const from = second(windowStart.getTime());
  const until = second(Math.min(windowEnd.getTime(), now));
  return Math.max(0, until - from);
}

/** The day so far, less the sleep in it. Never negative, however the records are edited. */
export function dayAwakeSeconds(windowStart: Date, windowEnd: Date, now: number, sleepSeconds: number) {
  return Math.max(0, dayElapsedSeconds(windowStart, windowEnd, now) - sleepSeconds);
}
