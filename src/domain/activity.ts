export const activityTypes = [
  "feeding",
  "diaper",
  "sleep",
  "pumping",
  "medicine",
  "measurement",
  "milestone",
  "note",
  "bath",
  "play",
  "mood",
  "supplement",
  "vaccine",
  "milk_inventory"
] as const;

export type ActivityTypeName = (typeof activityTypes)[number];

export type ActivityVisual = {
  artwork: string;
  toneClass: string;
};

export const activityLabels: Record<ActivityTypeName, string> = {
  feeding: "Feeding",
  diaper: "Diaper",
  sleep: "Sleep",
  pumping: "Pumping",
  medicine: "Medicine",
  measurement: "Measurement",
  milestone: "Milestone",
  note: "Note",
  bath: "Bath",
  play: "Play",
  mood: "Mood",
  supplement: "Supplement",
  vaccine: "Vaccine",
  milk_inventory: "Milk inventory"
};

export const timerActivityTypes = ["feeding", "sleep", "pumping", "play"] as const satisfies ActivityTypeName[];

export const dailySummaryActivityTypes = [
  "sleep",
  "feeding",
  "diaper",
  "bath",
  "pumping",
  "milestone",
  "medicine",
  "play",
  "supplement",
  "vaccine"
] as const satisfies ActivityTypeName[];

export type DailySummaryActivityType = (typeof dailySummaryActivityTypes)[number];

export const activityVisuals: Record<ActivityTypeName, ActivityVisual> = {
  feeding: { artwork: "/activity-art/feeding.webp", toneClass: "activity-tone-feeding" },
  diaper: { artwork: "/activity-art/diaper.webp", toneClass: "activity-tone-diaper" },
  sleep: { artwork: "/activity-art/sleep.webp", toneClass: "activity-tone-sleep" },
  pumping: { artwork: "/activity-art/pumping.webp", toneClass: "activity-tone-pumping" },
  medicine: { artwork: "/activity-art/medicine.webp", toneClass: "activity-tone-medicine" },
  measurement: { artwork: "/activity-art/measurement.webp", toneClass: "activity-tone-measurement" },
  milestone: { artwork: "/activity-art/milestone.webp", toneClass: "activity-tone-milestone" },
  note: { artwork: "/activity-art/note.webp", toneClass: "activity-tone-note" },
  bath: { artwork: "/activity-art/bath.webp", toneClass: "activity-tone-bath" },
  play: { artwork: "/activity-art/play.webp", toneClass: "activity-tone-play" },
  mood: { artwork: "/activity-art/mood.webp", toneClass: "activity-tone-mood" },
  supplement: { artwork: "/activity-art/supplement.webp", toneClass: "activity-tone-supplement" },
  vaccine: { artwork: "/activity-art/vaccine.webp", toneClass: "activity-tone-vaccine" },
  milk_inventory: { artwork: "/activity-art/milk_inventory.webp", toneClass: "activity-tone-milk-inventory" }
};

export function isActivityType(value: string): value is ActivityTypeName {
  return activityTypes.includes(value as ActivityTypeName);
}

export function isDailySummaryActivityType(value: string | undefined): value is DailySummaryActivityType {
  return Boolean(value && dailySummaryActivityTypes.includes(value as DailySummaryActivityType));
}

export function filterActivitiesBySummaryType<T extends { type: string }>(
  activities: T[],
  type?: DailySummaryActivityType
) {
  return type ? activities.filter((activity) => activity.type === type) : activities;
}

/**
 * The moment an activity is filed under on a given day.
 *
 * An activity that spans midnight belongs on every day it touches, and on each one the family is
 * asking a different question: on the evening it began, when it started; on the morning it ended,
 * when it ended. So the anchor is whichever end of the activity falls inside the day. Returns null
 * when the activity does not touch the day, including a still-running one seen from a later day --
 * it has no end yet, and the running timer is what reports that.
 *
 * The window is half-open, [start, end), matching the day query.
 */
export function activityDayAnchor(
  activity: { startedAt: Date; endedAt: Date | null },
  day: { start: Date; end: Date }
): Date | null {
  const startsInDay = activity.startedAt >= day.start && activity.startedAt < day.end;
  if (startsInDay) return activity.startedAt;
  if (!activity.endedAt) return null;
  const endsInDay = activity.endedAt > day.start && activity.endedAt < day.end;
  return endsInDay ? activity.endedAt : null;
}

/**
 * How an activity's time reads on a day's log.
 *
 * A moment reads as one time. An interval inside the day reads as a plain range. An activity that
 * crosses midnight carries a date on each end, because on the morning it ended "8:30 AM" alone
 * would misreport when it happened. The text is the same on both days it appears on; only where it
 * sits in the list changes.
 */
/**
 * Kept formatters for the row labels below.
 *
 * Building an Intl formatter costs far more than using one, and a label is built for every row of
 * the day log - a hundred at a time on the full log - so constructing them per row was most of the
 * work of rendering the page. Keyed by shape and zone, never by date, so nothing grows with how many
 * rows are shown.
 *
 * It stays at three entries because every caller passes the one zone the installation is configured
 * with. A change that made the zone per-baby or per-member would widen that, and nothing here evicts.
 */
const rowFormatters = new Map<string, Intl.DateTimeFormat>();

// A shape carries its own locale, so naming the shape names everything about the formatter except
// the zone.
//
// dayKey is not shown to anyone - it exists only to be compared against another day's, to decide
// whether an activity crossed midnight. What it needs is the year, the month and the day, and
// nothing that can differ between two moments on the SAME day: the zone's abbreviation changes when
// the clocks do, so including it would read a nap from 1:30 to 3:30 on that morning as overnight.
// The locale only decides how the three read; en-CA gives a sortable year-month-day, which is easy
// to recognise in a debugger, and any locale that keeps the three distinct would work as well.
const ROW_SHAPES = {
  time: { locale: "en", options: { hour: "numeric", minute: "2-digit" } },
  dateAndTime: { locale: "en", options: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } },
  dayKey: { locale: "en-CA", options: { year: "numeric", month: "2-digit", day: "2-digit" } }
} satisfies Record<string, { locale: string; options: Intl.DateTimeFormatOptions }>;

function rowFormatter(shape: keyof typeof ROW_SHAPES, timeZone: string) {
  const key = `${shape}|${timeZone}`;
  const cached = rowFormatters.get(key);
  if (cached) return cached;
  const { locale, options } = ROW_SHAPES[shape];
  const formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone });
  rowFormatters.set(key, formatter);
  return formatter;
}

/** Just the time of day, for a row with no day context to place it in. */
export function activityTimeLabel(value: Date, timeZone: string) {
  return rowFormatter("time", timeZone).format(value);
}

export function activityDayTimeLabel(
  activity: { startedAt: Date; endedAt: Date | null; running?: boolean },
  day: { start: Date; end: Date },
  timeZone: string
): { text: string; spansDays: boolean } {
  const time = (value: Date) => rowFormatter("time", timeZone).format(value);
  const dateAndTime = (value: Date) =>
    rowFormatter("dateAndTime", timeZone).format(value).replace(",", "");

  if (activity.running) return { text: `${time(activity.startedAt)} - now`, spansDays: false };
  if (!activity.endedAt) return { text: time(activity.startedAt), spansDays: false };

  const dayKey = (value: Date) => rowFormatter("dayKey", timeZone).format(value);
  const spansDays = dayKey(activity.startedAt) !== dayKey(activity.endedAt);

  if (!spansDays) return { text: `${time(activity.startedAt)} - ${time(activity.endedAt)}`, spansDays: false };
  return { text: `${dateAndTime(activity.startedAt)} - ${dateAndTime(activity.endedAt)}`, spansDays: true };
}
