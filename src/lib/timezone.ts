export const DEFAULT_APP_TIMEZONE = "America/New_York";

/**
 * Naming a day in a zone means asking Intl, and the expensive part is BUILDING the formatter rather
 * than using it - about thirteen times the cost. Reports asks once per entry and the calendar twice
 * per visible day, so a six-month report spent most of its time rebuilding the same few formatters.
 *
 * Both caches below are keyed by zone (and shape), never by date, so nothing grows with how much
 * history is being read. They stay small because every caller passes the one zone the installation
 * is configured with, or a baby's stored zone, which is written from that same setting - NOT a zone
 * taken from a request. A caller that ever forwards a user-supplied zone would be widening the key
 * space, and should bound it. A zone's rules cannot change while the process runs, so a kept
 * formatter cannot go stale.
 *
 * Everything exported from here resolves the zone it is given, so callers do not resolve it first and
 * must not resolve it again. Code outside this module that formats without coming through here - the
 * activity row labels in domain/activity.ts, which cannot import from lib - is therefore handed a
 * zone that has already been resolved by whoever read it.
 */
const resolvedZones = new Map<string, Map<string, string>>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timeZone: string, withTime: boolean) {
  const key = withTime ? `t:${timeZone}` : `d:${timeZone}`;
  const cached = dateFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", withTime
    ? {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }
    : { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  dateFormatters.set(key, formatter);
  return formatter;
}

/**
 * Kept formatters for the one-line times the app shows beside things: a moment's time on a feed
 * card, an event's start and end on the calendar, the hour behind a timeline's "Morning" heading.
 *
 * These are built once per item, and a page shows a lot of items - the Moments feed loads two
 * hundred posts - so the construction cost that mattered in the aggregations matters here too.
 *
 * The shapes are a closed list rather than options passed in by each caller. A caller that handed
 * over its own options would need a name to keep them under, and two callers choosing the same name
 * for different options would silently hand the second one the first's formatter. Naming the shapes
 * here means the name and the options cannot drift apart.
 */
/** Shapes for a real moment, which has to be read in the household's zone to mean anything. */
const INSTANT_SHAPES = {
  /** A time of day, as it reads beside an entry: "7:30 PM". */
  timeOfDay: { locale: "en-US", options: { hour: "numeric", minute: "2-digit" } },
  /** The hour alone, 0-23, for deciding which part of the day something falls in. */
  hourOfDay: { locale: "en-US", options: { hour: "numeric", hourCycle: "h23" } }
} satisfies Record<string, { locale: string; options: Intl.DateTimeFormatOptions }>;

/**
 * Shapes for a day key - a calendar date with no instant behind it, carried as midnight UTC.
 *
 * These take no zone, and the separate function below is why: read in a zone west of UTC a day key
 * lands on the day before, so there is no zone a caller could usefully pass. Keeping them out of the
 * zone-taking API means that mistake cannot be written rather than merely being unlikely.
 */
const DAY_KEY_SHAPES = {
  /** A day heading within the current year: "Mon, Jun 15". */
  dayHeading: { locale: "en-US", options: { weekday: "short", month: "short", day: "numeric" } },
  /** The same for an earlier year, where the year has to be said: "Mon, Jun 15, 2025". */
  dayHeadingWithYear: { locale: "en-US", options: { weekday: "short", month: "short", day: "numeric", year: "numeric" } },
  /** A day named in full, for a label read aloud by a screen reader: "Monday, June 15, 2026". */
  dayInFull: { locale: "en-US", options: { weekday: "long", month: "long", day: "numeric", year: "numeric" } }
} satisfies Record<string, { locale: string; options: Intl.DateTimeFormatOptions }>;

const displayFormatters = new Map<string, Intl.DateTimeFormat>();

export function displayFormatter(shape: keyof typeof INSTANT_SHAPES, timeZone: string) {
  const zone = normalizeTimeZone(timeZone);
  const key = `${shape}|${zone}`;
  const cached = displayFormatters.get(key);
  if (cached) return cached;
  const { locale, options } = INSTANT_SHAPES[shape];
  const formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone });
  displayFormatters.set(key, formatter);
  return formatter;
}

export function dayKeyFormatter(shape: keyof typeof DAY_KEY_SHAPES) {
  const cached = displayFormatters.get(shape);
  if (cached) return cached;
  const { locale, options } = DAY_KEY_SHAPES[shape];
  const formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
  displayFormatters.set(shape, formatter);
  return formatter;
}

export function normalizeTimeZone(timeZone: string | null | undefined, fallback = DEFAULT_APP_TIMEZONE) {
  const candidate = timeZone?.trim() || fallback;
  // Nested rather than a joined string, because the same candidate resolves differently under a
  // different fallback and no single separator is guaranteed absent from a caller's zone name.
  let byFallback = resolvedZones.get(candidate);
  if (!byFallback) resolvedZones.set(candidate, (byFallback = new Map()));
  const cached = byFallback.get(fallback);
  if (cached !== undefined) return cached;
  let resolved: string;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    resolved = candidate;
  } catch {
    resolved = candidate !== fallback ? normalizeTimeZone(fallback, "UTC") : "UTC";
  }
  byFallback.set(fallback, resolved);
  return resolved;
}

/** True when the runtime recognises `timeZone` as an IANA zone (e.g. "America/New_York"). */
export function isValidTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * An instant (a real moment: a feed, a backup, a sign-in) shown in the household's zone. Formatting
 * without a zone used the process zone on the server and the device zone in the browser, so the same
 * time could render differently on each and disagree with the rest of the app.
 */
export function formatInstant(value: Date | string | null | undefined, timeZone: string, options: { withYear?: boolean } = {}) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(timeZone),
    month: "short",
    day: "numeric",
    ...(options.withYear === false ? {} : { year: "numeric" as const }),
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

/** The calendar day of an instant in the household's zone, e.g. when an invitation expires. */
export function formatInstantDate(value: Date | string | null | undefined, timeZone: string) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: normalizeTimeZone(timeZone), month: "short", day: "numeric", year: "numeric" }).format(date);
}

/**
 * A calendar date with no time of day (a birth date). It is stored as midnight UTC of that date, so it
 * must be read back in UTC: shown in a zone west of UTC it would land on the previous day.
 */
export function formatCalendarDate(value: Date | string | null | undefined) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function addDaysToDateKey(key: string, days: number) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function dateKeyInTimeZone(date: Date, timeZone: string) {
  const parts = datePartsInTimeZone(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

export function dateTimeInputValue(date = new Date(), timeZone = DEFAULT_APP_TIMEZONE) {
  const parts = dateTimePartsInTimeZone(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

export function zonedDateStart(key: string, timeZone: string) {
  return zonedDateTimeToDate(`${key}T00:00:00`, timeZone);
}

export function zonedDateTimeToDate(value: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error("Invalid date");

  const [, yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] = match;
  const desired = Date.UTC(
    Number(yearValue),
    Number(monthValue) - 1,
    Number(dayValue),
    Number(hourValue),
    Number(minuteValue),
    Number(secondValue ?? "0")
  );
  let utc = desired;
  const safeTimeZone = normalizeTimeZone(timeZone);

  // A wall time that does not exist - the hour the clocks spring forward - has no answer to settle
  // on, and the correction below alternates between two instants rather than converging. An EVEN
  // number of passes is what makes that alternation land on the later one consistently, so this is
  // not a count that can be trimmed: three passes disagrees with four on hundreds of real days.
  for (let index = 0; index < 4; index += 1) {
    const parts = dateTimePartsInTimeZone(new Date(utc), safeTimeZone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    utc -= actual - desired;
  }

  return new Date(utc);
}

export function dateTimePartsInTimeZone(date: Date, timeZone: string) {
  // One formatter rather than two: this used to build a second one for the date half and throw away
  // the parts it had already been given.
  const values = dateFormatter(normalizeTimeZone(timeZone), true).formatToParts(date);
  return {
    year: part(values, "year"),
    month: part(values, "month"),
    day: part(values, "day"),
    hour: part(values, "hour"),
    minute: part(values, "minute"),
    second: part(values, "second")
  };
}

function datePartsInTimeZone(date: Date, timeZone: string) {
  const values = dateFormatter(normalizeTimeZone(timeZone), false).formatToParts(date);
  return { year: part(values, "year"), month: part(values, "month"), day: part(values, "day") };
}

function part(values: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return Number(values.find((value) => value.type === type)?.value);
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}
