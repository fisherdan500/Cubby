import { addDaysToDateKey, dateTimePartsInTimeZone, zonedDateStart } from "@/lib/timezone";

export type HistoryWeek =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; key: string; start: Date; end: Date };

export function resolveHistoryWeek(input: unknown, timeZone: string): HistoryWeek {
  if (input === undefined) return { status: "absent" };
  if (typeof input !== "string") return { status: "invalid" };
  const key = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return { status: "invalid" };
  const date = new Date(`${key}T00:00:00Z`);
  if (key.startsWith("0000") || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== key) {
    return { status: "invalid" };
  }
  if (date.getUTCDay() !== 1) return { status: "invalid" };
  // Keep the existing date-key helper away from Date.UTC's 0–99 remapping and five-digit years.
  // A 400-year Gregorian cycle preserves month lengths, including leap centuries.
  const year = date.getUTCFullYear();
  const shift = year < 100 ? 400 : year === 9999 ? -400 : 0;
  const safeKey = `${String(year + shift).padStart(4, "0")}${key.slice(4)}`;
  const end = new Date(`${addDaysToDateKey(safeKey, 7)}T00:00:00Z`);
  end.setUTCFullYear(end.getUTCFullYear() - shift);
  return {
    status: "valid", key,
    start: localMidnight(date, timeZone),
    end: localMidnight(end, timeZone)
  };
}

function localMidnight(date: Date, timeZone: string) {
  const year = date.getUTCFullYear();
  if (year >= 100 && year <= 9999) return zonedDateStart(date.toISOString().slice(0, 10), timeZone);
  // Resolve the exceptional years with setUTCFullYear, which does not remap 0–99.
  // Start at noon to keep the first local observation inside the AD era for 0001-01-01.
  let utc = date.getTime() + 12 * 3_600_000;
  for (let index = 0; index < 4; index += 1) {
    const parts = dateTimePartsInTimeZone(new Date(utc), timeZone);
    const actual = new Date(0);
    actual.setUTCFullYear(parts.year, parts.month - 1, parts.day);
    actual.setUTCHours(parts.hour, parts.minute, parts.second, 0);
    utc -= actual.getTime() - date.getTime();
  }
  return new Date(utc);
}
