import { z } from "zod";

/**
 * A caregiver-written plan for a baby's day (DEC-PROD-148 to 151): what is meant to happen and when.
 * It is always kept apart from what was logged - planning an item never logs anything, and logging
 * never changes the plan.
 *
 * This first version (DEC-PROD-420) is one plan per baby, with items at an exact time or within a
 * window. Medicine and supplements are left out until their approved safety fields exist; "3 hours
 * after" and order-only timing, templates and reminders come later.
 */

export const PLANNED_SCHEDULE_SCHEMA_VERSION = 1;
export const PLANNED_SCHEDULE_MAX_ITEMS = 40;
const LABEL_MAX = 60;
const NOTE_MAX = 300;

export const plannedScheduleKinds = ["wake", "feeding", "nap", "diaper", "pumping", "bath", "play", "bedtime", "custom"] as const;
export type PlannedScheduleKind = (typeof plannedScheduleKinds)[number];

export const plannedScheduleKindLabels: Record<PlannedScheduleKind, string> = {
  wake: "Wake up",
  feeding: "Feed",
  nap: "Nap",
  diaper: "Diaper change",
  pumping: "Pump",
  bath: "Bath",
  play: "Play",
  bedtime: "Bedtime",
  custom: "Something else"
};

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
// Text a caregiver typed: no control characters other than line breaks in a note.
const label = z.string().trim().max(LABEL_MAX).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const note = z.string().trim().max(NOTE_MAX).refine((value) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value));

const timingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("exact"), at: clockTime }).strict(),
  z.object({ mode: z.literal("window"), from: clockTime, to: clockTime }).strict()
    .refine((timing) => timing.from < timing.to, { message: "window_order" })
]);

const itemSchema = z
  .object({
    kind: z.enum(plannedScheduleKinds),
    label: label.nullable(),
    timing: timingSchema,
    note: note.nullable()
  })
  .strict()
  .transform((item) => ({ ...item, label: item.label || null, note: item.note || null }))
  .refine((item) => (item.kind === "custom") === (item.label !== null), { message: "custom_label" });

export type PlannedScheduleItem = z.output<typeof itemSchema>;
export type PlannedScheduleTiming = PlannedScheduleItem["timing"];

export const plannedScheduleItemsSchema = z
  .array(itemSchema)
  .max(PLANNED_SCHEDULE_MAX_ITEMS)
  .transform((items) => [...items].sort((left, right) => startMinutes(left.timing) - startMinutes(right.timing)));

export function parsePlannedScheduleItems(raw: unknown): PlannedScheduleItem[] {
  return plannedScheduleItemsSchema.parse(raw);
}

/** A stored plan: its items and the revision every save is checked against. */
export const plannedScheduleDocumentSchema = z
  .object({ schemaVersion: z.literal(PLANNED_SCHEDULE_SCHEMA_VERSION), items: plannedScheduleItemsSchema })
  .strict();

export function scheduleItemLabel(item: Pick<PlannedScheduleItem, "kind" | "label">) {
  return item.kind === "custom" ? item.label ?? plannedScheduleKindLabels.custom : plannedScheduleKindLabels[item.kind];
}

export function formatScheduleTiming(timing: PlannedScheduleTiming) {
  return timing.mode === "exact" ? formatClock(timing.at) : `${formatClock(timing.from)} to ${formatClock(timing.to)}`;
}

export function startMinutes(timing: PlannedScheduleTiming) {
  const [hours, minutes] = (timing.mode === "exact" ? timing.at : timing.from).split(":").map(Number);
  return hours * 60 + minutes;
}

function formatClock(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours >= 12 ? "PM" : "AM"}`;
}
