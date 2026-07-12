import type { ActivityTypeName } from "@/domain/activity";

export const routineActivityTypes = [
  "sleep",
  "feeding",
  "diaper",
  "pumping",
  "medicine",
  "supplement",
  "bath",
  "play"
] as const satisfies readonly ActivityTypeName[];

export type RoutineActivityType = (typeof routineActivityTypes)[number];

export const defaultRoutineActivityTypes = [
  "sleep",
  "feeding",
  "diaper"
] as const satisfies readonly RoutineActivityType[];

export type RoutineRow = {
  index: number;
  type: RoutineActivityType;
  averageMinutes: number;
  averageTime: string;
  averageDurationSeconds: number;
  averageDuration: string | null;
  sampleCount: number;
};

export function isRoutineActivityType(value: unknown): value is RoutineActivityType {
  return typeof value === "string" && routineActivityTypes.includes(value as RoutineActivityType);
}
