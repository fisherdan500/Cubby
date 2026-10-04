export function durationSeconds(start: Date, end: Date) {
  return Math.max(0, Math.round(end.getTime() / 1_000) - Math.round(start.getTime() / 1_000));
}

export function parseDateInput(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid date");
  }
  return date;
}
