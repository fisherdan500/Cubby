export const activityTypes = [
  "feeding",
  "diaper",
  "sleep",
  "pumping",
  "medicine",
  "measurement",
  "milestone",
  "note"
] as const;

export type ActivityTypeName = (typeof activityTypes)[number];

export const activityLabels: Record<ActivityTypeName, string> = {
  feeding: "Feeding",
  diaper: "Diaper",
  sleep: "Sleep",
  pumping: "Pumping",
  medicine: "Medicine",
  measurement: "Measurement",
  milestone: "Milestone",
  note: "Note"
};
