export const DEFAULT_APP_TIMEZONE = "America/New_York";

export function normalizeTimeZone(timeZone: string | null | undefined, fallback = DEFAULT_APP_TIMEZONE) {
  const candidate = timeZone?.trim() || fallback;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    if (candidate !== fallback) return normalizeTimeZone(fallback, "UTC");
    return "UTC";
  }
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

  for (let index = 0; index < 4; index += 1) {
    const parts = dateTimePartsInTimeZone(new Date(utc), safeTimeZone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    utc -= actual - desired;
  }

  return new Date(utc);
}

export function dateTimePartsInTimeZone(date: Date, timeZone: string) {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return {
    ...datePartsInTimeZone(date, timeZone),
    hour: Number(values.find((part) => part.type === "hour")?.value),
    minute: Number(values.find((part) => part.type === "minute")?.value),
    second: Number(values.find((part) => part.type === "second")?.value)
  };
}

function datePartsInTimeZone(date: Date, timeZone: string) {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  return {
    year: Number(values.find((part) => part.type === "year")?.value),
    month: Number(values.find((part) => part.type === "month")?.value),
    day: Number(values.find((part) => part.type === "day")?.value)
  };
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}
