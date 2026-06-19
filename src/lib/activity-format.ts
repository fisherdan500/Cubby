import type {
  ActivityLog,
  Baby,
  DiaperLog,
  FeedingLog,
  MeasurementLog,
  MedicineLog,
  MilestoneLog,
  NoteLog,
  PumpingLog
} from "@prisma/client";

export type ActivityWithDetails = ActivityLog & {
  baby: Baby;
  feeding?: FeedingLog | null;
  diaper?: DiaperLog | null;
  pumping?: PumpingLog | null;
  medicine?: MedicineLog | null;
  measurement?: MeasurementLog | null;
  milestone?: MilestoneLog | null;
  note?: NoteLog | null;
  actorMember?: { displayName: string | null; user: { name: string } };
};

export function formatDateTime(date: Date | string | null | undefined) {
  if (!date) return "";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(date));
}

export function formatDuration(seconds?: number | null) {
  if (!seconds) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function describeActivity(activity: ActivityWithDetails) {
  switch (activity.type) {
    case "feeding":
      return [
        activity.feeding?.mode,
        activity.feeding?.amount ? `${activity.feeding.amount} ${activity.feeding.unit ?? ""}`.trim() : "",
        activity.feeding?.side ? `${activity.feeding.side} side` : "",
        formatDuration(activity.durationSeconds)
      ]
        .filter(Boolean)
        .join(" · ");
    case "diaper":
      return [
        activity.diaper?.kind,
        activity.diaper?.rashConcern ? "rash concern" : "",
        activity.diaper?.color
      ]
        .filter(Boolean)
        .join(" · ");
    case "sleep":
      return activity.timerState === "running" ? "Timer running" : formatDuration(activity.durationSeconds);
    case "pumping":
      return [
        activity.pumping?.amount ? `${activity.pumping.amount} ${activity.pumping.unit ?? ""}`.trim() : "",
        activity.pumping?.leftAmount ? `L ${activity.pumping.leftAmount}` : "",
        activity.pumping?.rightAmount ? `R ${activity.pumping.rightAmount}` : "",
        formatDuration(activity.durationSeconds)
      ]
        .filter(Boolean)
        .join(" · ");
    case "medicine":
      return [
        activity.medicine?.name,
        activity.medicine?.dose ? `${activity.medicine.dose} ${activity.medicine.unit ?? ""}`.trim() : ""
      ]
        .filter(Boolean)
        .join(" · ");
    case "measurement":
      return [
        activity.measurement?.weight
          ? `Weight ${activity.measurement.weight} ${activity.measurement.weightUnit ?? ""}`.trim()
          : "",
        activity.measurement?.length
          ? `Length ${activity.measurement.length} ${activity.measurement.lengthUnit ?? ""}`.trim()
          : "",
        activity.measurement?.headCircumference
          ? `Head ${activity.measurement.headCircumference} ${activity.measurement.headUnit ?? ""}`.trim()
          : ""
      ]
        .filter(Boolean)
        .join(" · ");
    case "milestone":
      return [activity.milestone?.title, activity.milestone?.category].filter(Boolean).join(" · ");
    case "note":
      return [activity.note?.category, activity.note?.text].filter(Boolean).join(" · ");
    default:
      return activity.notes ?? "";
  }
}
