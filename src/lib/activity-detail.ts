import type { ActivityTypeName } from "@/domain/activity";
import {
  activityDetailFields,
  activityDetailRecord,
  type ActivityFieldDeclaration
} from "@/domain/activity-field-matrix";
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

/**
 * Every saved detail of an activity as one labelled line, for an export. The list view's summary is
 * deliberately terse and leaves fields out; an export is the household's own copy of its records, so it
 * carries everything the entry actually holds, under the same labels the app shows.
 */
export function activityDetailText(activity: ActivityWithDetails, timeZone = activity.timezone) {
  return detailRows(activity, timeZone)
    .map(({ label: rowLabel, value }) => `${rowLabel}: ${value}`)
    .join("; ");
}

function timingRows(activity: ActivityWithDetails, timeZone: string): ActivityDetailRow[] {
  return compactRows([
    activity.timerState !== "none" ? row("Timer", displayLabel(activity.timerState)) : null,
    dateRow("Started", activity.startedAt, timeZone),
    dateRow("Ended", activity.endedAt, timeZone),
    row("Duration", duration(activity.durationSeconds))
  ]);
}

/**
 * Every field the matrix gives a label, in the order it declares them. The view no longer keeps its own
 * copy of each type's field list, so a newly stored field cannot be missing from the entry a caregiver
 * reads back.
 */
function detailRows(activity: ActivityWithDetails, timeZone: string): ActivityDetailRow[] {
  const detail = activityDetailRecord(activity as unknown as { type: string } & Record<string, unknown>);
  if (!detail) return [];
  return compactRows(
    activityDetailFields(activity.type as ActivityTypeName).map((field) =>
      detailRow(field, detail[field.name], detail, timeZone)
    )
  );
}

function detailRow(
  field: ActivityFieldDeclaration,
  value: unknown,
  detail: Record<string, unknown>,
  timeZone: string
): ActivityDetailRow | null {
  const rowLabel = field.label!;
  switch (field.kind) {
    case "enum":
      return row(rowLabel, label(value));
    case "quantity":
      return row(rowLabel, quantity(value, field.unitField ? detail[field.unitField] : undefined));
    case "duration":
      return row(rowLabel, duration(value as number | null | undefined));
    case "scale":
      return row(rowLabel, meaningful(value) ? `${value}/5` : undefined);
    case "boolean":
      return trueRow(rowLabel, value as boolean | null | undefined);
    case "date":
      return dateRow(rowLabel, value as Date | string | null | undefined, timeZone, true);
    case "unit":
      return null;
    case "text":
      return row(rowLabel, value);
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
