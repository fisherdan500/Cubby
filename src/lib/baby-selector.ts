import type { ActivityTypeName } from "@/domain/activity";

export const SELECTED_BABY_COOKIE = "cubby_selected_baby_id";
export const SELECTED_BABY_STORAGE_KEY = "cubby.selectedBabyId";

export type BabySelectorBaby = {
  id: string;
  name: string;
  ageLabel: string;
};

export type HeaderBabySelectorData = {
  babies: BabySelectorBaby[];
  selectedBabyId: string;
  activeTimerType?: ActivityTypeName;
};

export function formatBabyAge(birthDate?: Date | string | null, now = new Date()) {
  if (!birthDate) return "Age not set";
  const birth = birthDate instanceof Date ? birthDate : new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return "Age not set";

  const days = Math.max(0, Math.floor((utcDay(now).getTime() - utcDay(birth).getTime()) / 86_400_000));
  if (days < 7) return plural(days, "day");
  if (days < 24 * 7) return plural(Math.max(1, Math.floor(days / 7)), "week");
  return plural(Math.max(1, wholeMonths(birth, now)), "month");
}

export function resolveSelectedBaby<T extends { id: string }>(
  babies: T[],
  requestedBabyId?: string | null,
  cachedBabyId?: string | null
) {
  return (
    babies.find((baby) => baby.id === requestedBabyId) ??
    babies.find((baby) => baby.id === cachedBabyId) ??
    babies[0] ??
    null
  );
}

function utcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function wholeMonths(birth: Date, now: Date) {
  let months = (now.getUTCFullYear() - birth.getUTCFullYear()) * 12 + now.getUTCMonth() - birth.getUTCMonth();
  if (now.getUTCDate() < birth.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

function plural(value: number, unit: string) {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}
