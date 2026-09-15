import { dateTimeInputValue } from "@/lib/timezone";

/**
 * Household wall-clock values in the "YYYY-MM-DDTHH:mm" form the activity API already accepts.
 * Arithmetic here is on wall-clock fields only; the server resolves them against the household
 * timezone, so no browser/device timezone ever participates.
 */
const WALL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export type WallParts = { date: string; hour: number; minute: number };

export function isWallTime(value: string | undefined | null): value is string {
  return typeof value === "string" && WALL_PATTERN.test(value);
}

export function nowWallTime(timeZone: string, now = new Date()) {
  return dateTimeInputValue(now, timeZone);
}

function wallMs(value: string) {
  const match = WALL_PATTERN.exec(value);
  if (!match) throw new Error("Invalid wall time");
  const [, year, month, day, hour, minute] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
}

function fromMs(ms: number) {
  return new Date(ms).toISOString().slice(0, 16);
}

export function addMinutes(value: string, minutes: number) {
  return fromMs(wallMs(value) + minutes * 60_000);
}

export function minutesBetween(start: string, end: string) {
  return Math.round((wallMs(end) - wallMs(start)) / 60_000);
}

export function wallParts(value: string): WallParts {
  return { date: value.slice(0, 10), hour: Number(value.slice(11, 13)), minute: Number(value.slice(14, 16)) };
}

export function joinWall({ date, hour, minute }: WallParts) {
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function to12Hour(hour: number) {
  return { hour12: hour % 12 === 0 ? 12 : hour % 12, period: hour < 12 ? ("AM" as const) : ("PM" as const) };
}

export function from12Hour(hour12: number, period: "AM" | "PM") {
  return (hour12 % 12) + (period === "PM" ? 12 : 0);
}

export function formatClock(value: string) {
  const { hour, minute } = wallParts(value);
  const { hour12, period } = to12Hour(hour);
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

export function formatDay(value: string, now: string) {
  const days = Math.round((wallMs(`${value.slice(0, 10)}T00:00`) - wallMs(`${now.slice(0, 10)}T00:00`)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === -1) return "Yesterday";
  if (days === 1) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(value.slice(0, 4) === now.slice(0, 4) ? {} : { year: "numeric" })
  }).format(new Date(wallMs(value)));
}

export function formatWall(value: string, now: string) {
  return `${formatDay(value, now)}, ${formatClock(value)}`;
}

export function formatMinutes(total: number) {
  const hours = Math.floor(Math.abs(total) / 60);
  const minutes = Math.abs(total) % 60;
  if (!hours) return `${minutes} min`;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

export function formatRelative(value: string, now: string) {
  const diff = minutesBetween(value, now);
  if (diff === 0) return "Right now";
  return diff > 0 ? `${formatMinutes(diff)} ago` : `In ${formatMinutes(diff)}`;
}
