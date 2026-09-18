import type {
  ActivityLog,
  Baby,
  BathLog,
  DiaperLog,
  FeedingLog,
  MeasurementLog,
  MedicineLog,
  MilestoneLog,
  MilkInventoryLog,
  MoodLog,
  NoteLog,
  PlayLog,
  PumpingLog,
  SleepLog,
  SupplementLog,
  VaccineLog
} from "@prisma/client";
import { convertVolume, normalizeVolumeUnit, type VolumeUnit } from "@/domain/units";

export type ActivityWithDetails = ActivityLog & {
  baby: Baby;
  feeding?: FeedingLog | null;
  diaper?: DiaperLog | null;
  sleep?: SleepLog | null;
  pumping?: PumpingLog | null;
  medicine?: MedicineLog | null;
  measurement?: MeasurementLog | null;
  milestone?: MilestoneLog | null;
  note?: NoteLog | null;
  bath?: BathLog | null;
  play?: PlayLog | null;
  mood?: MoodLog | null;
  supplement?: SupplementLog | null;
  vaccine?: VaccineLog | null;
  milkInventory?: MilkInventoryLog | null;
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

export function formatElapsedBadge(date: Date | string | null | undefined, now = new Date()) {
  if (!date) return null;
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  const minutes = Math.max(0, Math.floor((now.getTime() - value.getTime()) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}:${String(rest).padStart(2, "0")}`;
}

/**
 * "17m ago", "2h 34m ago", "3d ago" - for the dashboard tiles, where a bare "2:34" read like a stat
 * with no label. Anything in the future (a clock skew, or an entry logged ahead) reads as "just now"
 * rather than a negative duration.
 */
export function formatTimeSince(date: Date | string | null | undefined, now = new Date()) {
  if (!date) return null;
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  const minutes = Math.floor((now.getTime() - value.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m ago` : `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Shows a volume exactly as saved; when a household display unit is given and the saved unit differs,
 * appends an approximate conversion so mixed-unit days stay comparable. The saved value never changes.
 */
export function formatVolume(amount: unknown, unit: string | null | undefined, display?: VolumeUnit) {
  const saved = `${amount} ${unit ?? ""}`.trim();
  const source = unit ? normalizeVolumeUnit(unit) : null;
  if (!display || !source || source === display) return saved;
  const converted = convertVolume(Number(amount), source, display);
  if (converted === null) return saved;
  const rounded = display === "oz" ? Math.round(converted * 10) / 10 : Math.round(converted);
  return `${saved} (≈ ${rounded} ${display})`;
}

export function describeActivity(activity: ActivityWithDetails, options: { volume?: VolumeUnit } = {}) {
  switch (activity.type) {
    case "feeding":
      return [
        activity.feeding?.mode,
        activity.feeding?.bottleType,
        activity.feeding?.food,
        activity.feeding?.amount ? formatVolume(activity.feeding.amount, activity.feeding.unit, options.volume) : "",
        activity.feeding?.side ? `${activity.feeding.side} side` : "",
        formatDuration(activity.durationSeconds)
      ]
        .filter(Boolean)
        .join(" - ");
    case "diaper":
      return [
        activity.diaper?.kind,
        activity.diaper?.condition,
        activity.diaper?.rashConcern ? "rash concern" : "",
        activity.diaper?.blowout ? "blowout" : "",
        activity.diaper?.creamApplied ? "cream applied" : "",
        activity.diaper?.color
      ]
        .filter(Boolean)
        .join(" - ");
    case "sleep":
      return [
        activity.timerState === "running" ? "Timer running" : "",
        activity.timerState === "paused" ? "Timer paused" : "",
        activity.sleep?.sleepType,
        activity.sleep?.location,
        activity.sleep?.quality,
        formatDuration(activity.durationSeconds)
      ]
        .filter(Boolean)
        .join(" - ");
    case "pumping":
      return [
        activity.pumping?.amount ? formatVolume(activity.pumping.amount, activity.pumping.unit, options.volume) : "",
        activity.pumping?.leftAmount ? `L ${activity.pumping.leftAmount}` : "",
        activity.pumping?.rightAmount ? `R ${activity.pumping.rightAmount}` : "",
        activity.pumping?.inventoryAction,
        formatDuration(activity.durationSeconds)
      ]
        .filter(Boolean)
        .join(" - ");
    case "medicine":
      return [
        activity.medicine?.name,
        activity.medicine?.dose ? `${activity.medicine.dose} ${activity.medicine.unit ?? ""}`.trim() : ""
      ]
        .filter(Boolean)
        .join(" - ");
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
          : "",
        activity.measurement?.temperature
          ? `Temp ${activity.measurement.temperature} ${activity.measurement.temperatureUnit ?? ""}`.trim()
          : ""
      ]
        .filter(Boolean)
        .join(" - ");
    case "milestone":
      return [activity.milestone?.title, activity.milestone?.category].filter(Boolean).join(" - ");
    case "note":
      return [activity.note?.category, activity.note?.text].filter(Boolean).join(" - ");
    case "bath":
      return [activity.bath?.bathType, activity.bath?.products, activity.bath?.waterTemp].filter(Boolean).join(" - ");
    case "play":
      return [
        activity.timerState === "running" ? "Timer running" : "",
        activity.timerState === "paused" ? "Timer paused" : "",
        activity.play?.activityName,
        activity.play?.location,
        activity.play?.intensity,
        formatDuration(activity.durationSeconds)
      ]
        .filter(Boolean)
        .join(" - ");
    case "mood":
      return [
        activity.mood?.mood,
        activity.mood?.intensity ? `${activity.mood.intensity}/5` : "",
        activity.mood?.context
      ]
        .filter(Boolean)
        .join(" - ");
    case "supplement":
      return [
        activity.supplement?.name,
        activity.supplement?.dose ? `${activity.supplement.dose} ${activity.supplement.unit ?? ""}`.trim() : ""
      ]
        .filter(Boolean)
        .join(" - ");
    case "vaccine":
      return [activity.vaccine?.name, activity.vaccine?.dose, activity.vaccine?.provider].filter(Boolean).join(" - ");
    case "milk_inventory":
      return [
        activity.milkInventory?.action,
        activity.milkInventory?.amount
          ? formatVolume(activity.milkInventory.amount, activity.milkInventory.unit, options.volume)
          : "",
        activity.milkInventory?.storage,
        activity.milkInventory?.label
      ]
        .filter(Boolean)
        .join(" - ");
    default:
      return activity.notes ?? "";
  }
}
