import {
  defaultRoutineActivityTypes,
  isRoutineActivityType,
  type RoutineActivityType
} from "@/domain/routine";

export const ROUTINE_ACTIVITY_STORAGE_KEY = "cubby:routine-activity-types:v1";

export function parseRoutineActivitySelection(raw: string | null): RoutineActivityType[] {
  if (raw === null) return [...defaultRoutineActivityTypes];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...defaultRoutineActivityTypes];
    return [...new Set(parsed.filter(isRoutineActivityType))];
  } catch {
    return [...defaultRoutineActivityTypes];
  }
}

export function serializeRoutineActivitySelection(selection: readonly RoutineActivityType[]) {
  return JSON.stringify(selection);
}

export function filterRoutineRows<T extends { type: RoutineActivityType }>(
  rows: readonly T[],
  selection: readonly RoutineActivityType[]
) {
  const selected = new Set(selection);
  return rows.filter((row) => selected.has(row.type));
}
