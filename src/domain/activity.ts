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
