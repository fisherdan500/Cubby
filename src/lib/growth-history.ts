/**
 * Growth and milestones read as a history rather than as a window: babies are weighed and measured
 * weeks apart, so the question is "what is the latest, and how has it changed", and milestones are
 * a record kept for good, grouped the way people remember them - by month, and by age.
 */

type GrowthPoint = { date: string; value: number; unit: string; ageMonths: number | null };

export function growthSeries(points: GrowthPoint[] | null) {
  if (points === null) return null;
  const ordered = [...points].sort((left, right) => left.date.localeCompare(right.date));
  const entries = ordered
    .map((point, index) => ({
      date: formatDateKey(point.date, true),
      age: formatAge(point.ageMonths),
      value: `${trim(point.value)} ${point.unit}`,
      change: index === 0 ? null : change(point.value - ordered[index - 1].value, point.unit)
    }))
    .reverse();
  const latest = ordered.at(-1);
  const before = ordered.at(-2);
  return {
    latest: latest ? { value: `${trim(latest.value)} ${latest.unit}`, date: formatDateKey(latest.date, true), age: formatAge(latest.ageMonths) } : null,
    sinceLast: latest && before ? { change: change(latest.value - before.value, latest.unit), since: formatDateKey(before.date, false) } : null,
    entries
  };
}

/** An age as a parent would say it: weeks for a newborn, then months, then years and months. */
export function formatAge(ageMonths: number | null) {
  if (ageMonths === null) return null;
  if (ageMonths < 1) {
    const weeks = Math.round((ageMonths * 30.4375) / 7);
    return weeks < 1 ? "Under a week" : `${weeks} ${weeks === 1 ? "week" : "weeks"}`;
  }
  const whole = Math.floor(ageMonths);
  const years = Math.floor(whole / 12);
  const months = whole % 12;
  const monthText = months ? `${months} ${months === 1 ? "month" : "months"}` : "";
  if (!years) return monthText;
  const yearText = `${years} ${years === 1 ? "year" : "years"}`;
  return monthText ? `${yearText} ${monthText}` : yearText;
}

export function milestoneTimeline(
  milestones: Array<{ date: Date; title: string; category?: string | null; ageMonths: number | null }>,
  timeZone: string
) {
  const monthFormat = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone });
  const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone });
  const groups: Array<{ month: string; items: Array<{ title: string; category: string | null; date: string; age: string | null }> }> = [];
  for (const milestone of [...milestones].sort((left, right) => right.date.getTime() - left.date.getTime())) {
    const month = monthFormat.format(milestone.date);
    const item = { title: milestone.title, category: milestone.category ?? null, date: dayFormat.format(milestone.date), age: formatAge(milestone.ageMonths) };
    const current = groups.at(-1);
    if (current?.month === month) current.items.push(item);
    else groups.push({ month, items: [item] });
  }
  return groups;
}

function change(difference: number, unit: string) {
  const rounded = Number(difference.toFixed(2));
  if (Math.abs(rounded) < 0.005) return "Same";
  // A true minus sign, so the change reads as a number rather than a hyphen.
  return `${rounded > 0 ? "+" : "−"}${trim(Math.abs(rounded))} ${unit}`;
}

function trim(value: number) {
  return String(Number(value.toFixed(2)));
}

function formatDateKey(key: string, withYear: boolean) {
  const [year, month, day] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" as const } : {}), timeZone: "UTC" })
    .format(new Date(Date.UTC(year, month - 1, day)));
}
