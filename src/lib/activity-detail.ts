import type { ActivityWithDetails } from "@/lib/activity-format";
import { formatDuration } from "@/lib/activity-format";
import { displayLabel } from "@/lib/display-label";
import { normalizeTimeZone } from "@/lib/timezone";

export type ActivityDetailRow = { label: string; value: string };
export type ActivityDetailSection = { title: string; rows: ActivityDetailRow[] };

export function buildActivityDetailSections(activity: ActivityWithDetails, timeZone = activity.timezone) {
  const sections = [
    { title: "Timing", rows: timingRows(activity, timeZone) },
    { title: "Details", rows: detailRows(activity, timeZone) }
  ].filter(({ rows }) => rows.length > 0);

  return {
    sections,
    notes: text(activity.notes)
  };
}

function timingRows(activity: ActivityWithDetails, timeZone: string): ActivityDetailRow[] {
  return compactRows([
    activity.timerState !== "none" ? row("Timer", displayLabel(activity.timerState)) : null,
    dateRow("Started", activity.startedAt, timeZone),
    dateRow("Ended", activity.endedAt, timeZone),
    row("Duration", duration(activity.durationSeconds))
  ]);
}

function detailRows(activity: ActivityWithDetails, timeZone: string): ActivityDetailRow[] {
  switch (activity.type) {
    case "feeding":
      return compactRows([
        row("Kind", label(activity.feeding?.mode)),
        row("Amount", quantity(activity.feeding?.amount, activity.feeding?.unit)),
        row("Side", label(activity.feeding?.side)),
        row("Bottle type", activity.feeding?.bottleType),
        row("Food", activity.feeding?.food),
        row("Left side", duration(activity.feeding?.leftSeconds)),
        row("Right side", duration(activity.feeding?.rightSeconds))
      ]);
    case "diaper":
      return compactRows([
        row("Kind", label(activity.diaper?.kind)),
        row("Color", activity.diaper?.color),
        row("Consistency", activity.diaper?.consistency),
        row("Condition", activity.diaper?.condition),
        trueRow("Rash concern", activity.diaper?.rashConcern),
        trueRow("Blowout", activity.diaper?.blowout),
        trueRow("Cream applied", activity.diaper?.creamApplied)
      ]);
    case "sleep":
      return compactRows([
        row("Sleep type", label(activity.sleep?.sleepType)),
        row("Location", activity.sleep?.location),
        row("Quality", label(activity.sleep?.quality))
      ]);
    case "pumping":
      return compactRows([
        row("Amount", quantity(activity.pumping?.amount, activity.pumping?.unit)),
        row("Left amount", quantity(activity.pumping?.leftAmount, activity.pumping?.unit)),
        row("Right amount", quantity(activity.pumping?.rightAmount, activity.pumping?.unit)),
        row("Inventory action", label(activity.pumping?.inventoryAction))
      ]);
    case "medicine":
      return compactRows([
        row("Medicine", activity.medicine?.name),
        row("Dose", quantity(activity.medicine?.dose, activity.medicine?.unit))
      ]);
    case "measurement":
      return compactRows([
        row("Measurement type", label(activity.measurement?.measurementType)),
        row("Weight", quantity(activity.measurement?.weight, activity.measurement?.weightUnit)),
        row("Length", quantity(activity.measurement?.length, activity.measurement?.lengthUnit)),
        row("Head circumference", quantity(activity.measurement?.headCircumference, activity.measurement?.headUnit)),
        row("Temperature", quantity(activity.measurement?.temperature, activity.measurement?.temperatureUnit))
      ]);
    case "milestone":
      return compactRows([
        row("Milestone", activity.milestone?.title),
        row("Category", label(activity.milestone?.category))
      ]);
    case "note":
      return compactRows([row("Category", label(activity.note?.category)), row("Entry", activity.note?.text)]);
    case "bath":
      return compactRows([
        row("Bath type", label(activity.bath?.bathType)),
        row("Products", activity.bath?.products),
        row("Water temperature", activity.bath?.waterTemp)
      ]);
    case "play":
      return compactRows([
        row("Activity", activity.play?.activityName),
        row("Location", activity.play?.location),
        row("Intensity", label(activity.play?.intensity))
      ]);
    case "mood":
      return compactRows([
        row("Mood", label(activity.mood?.mood)),
        row("Intensity", meaningful(activity.mood?.intensity) ? `${activity.mood?.intensity}/5` : undefined),
        row("Context", activity.mood?.context)
      ]);
    case "supplement":
      return compactRows([
        row("Supplement", activity.supplement?.name),
        row("Dose", quantity(activity.supplement?.dose, activity.supplement?.unit))
      ]);
    case "vaccine":
      return compactRows([
        row("Vaccine", activity.vaccine?.name),
        row("Dose", activity.vaccine?.dose),
        row("Lot", activity.vaccine?.lot),
        row("Provider", activity.vaccine?.provider),
        dateRow("Due date", activity.vaccine?.dueDate, timeZone, true),
        row("Document", activity.vaccine?.documentUrl)
      ]);
    case "milk_inventory":
      return compactRows([
        row("Action", label(activity.milkInventory?.action)),
        row("Amount", quantity(activity.milkInventory?.amount, activity.milkInventory?.unit)),
        row("Storage", activity.milkInventory?.storage),
        row("Label", activity.milkInventory?.label)
      ]);
    default: {
      const exhaustive: never = activity.type;
      return exhaustive;
    }
  }
}

function compactRows(rows: Array<ActivityDetailRow | null>) {
  return rows.filter((value): value is ActivityDetailRow => value !== null);
}

function row(labelValue: string, rawValue: unknown): ActivityDetailRow | null {
  const value = text(rawValue);
  return value === undefined ? null : { label: labelValue, value };
}

function trueRow(labelValue: string, value: boolean | null | undefined) {
  return value ? { label: labelValue, value: "Yes" } : null;
}

function label(value: unknown) {
  const normalized = text(value);
  return normalized === undefined ? undefined : displayLabel(normalized);
}

function quantity(value: unknown, unit: unknown) {
  if (!meaningful(value)) return undefined;
  return [String(value), text(unit)].filter(Boolean).join(" ");
}

function duration(value: number | null | undefined) {
  if (!meaningful(value)) return undefined;
  return value === 0 ? "0 min" : formatDuration(value);
}

function dateRow(labelValue: string, value: Date | string | null | undefined, timeZone: string, dateOnly = false) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: dateOnly ? "UTC" : normalizeTimeZone(timeZone),
    month: "short",
    day: "numeric",
    year: dateOnly ? "numeric" : undefined,
    hour: dateOnly ? undefined : "numeric",
    minute: dateOnly ? undefined : "2-digit"
  }).format(date);
  return { label: labelValue, value: formatted };
}

function meaningful(value: unknown) {
  return value !== undefined && value !== null && value !== "" && value !== false;
}

function text(value: unknown) {
  if (!meaningful(value)) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}
