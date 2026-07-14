import { itemUnitPreference } from "@/domain/unit-preferences";

export function hasActivityDetail(initial: Record<string, unknown> | undefined, fields: string[]) {
  return fields.some((field) => {
    const value = initial?.[field];
    return value !== undefined && value !== null && value !== "" && value !== false;
  });
}

export function resolveActivityUnit({
  saved,
  preferred,
  fallback
}: {
  saved?: string | null;
  preferred?: string | null;
  fallback: string;
}) {
  return [saved, preferred, fallback].find((unit) => unit?.trim())?.trim() ?? fallback;
}

export function resolveFormUnit({
  editing,
  saved,
  preferred,
  fallback
}: {
  editing: boolean;
  saved?: string | null;
  preferred?: string | null;
  fallback: string;
}) {
  if (editing && !saved?.trim()) return "";
  return resolveActivityUnit({ saved, preferred, fallback });
}

export function resolveItemDoseUnit({
  saved,
  name,
  units
}: {
  saved?: string | null;
  name?: string | null;
  units: Record<string, string>;
}) {
  return resolveActivityUnit({
    saved,
    preferred: itemUnitPreference(units, name),
    fallback: ""
  });
}
