import { convertVolume, normalizeVolumeUnit } from "@/domain/units";

/** A baby's newest feed, as a new feed starts from it: its kind, and the newest bottle or formula amount. */
export type LastFeeding = { mode: string; amount: string | null; unit: string | null };

/**
 * Where a new feed's form starts, so a caregiver who gives the same bottle every time does not type it
 * or tap + to it each time. The kind is the last feed's; the amount is the last bottle or formula
 * amount, in the form's unit - converted, to the nearest step the stepper moves by, if the household
 * changed units since.
 */
export function feedingFormStart(last: LastFeeding | null | undefined, formUnit: string): { mode: string; amount: string | null } {
  if (!last) return { mode: "bottle", amount: null };
  const amount = last.amount === null ? null : Number(last.amount);
  if (amount === null || !Number.isFinite(amount)) return { mode: last.mode, amount: null };

  const target = normalizeVolumeUnit(formUnit);
  const source = normalizeVolumeUnit(last.unit ?? formUnit);
  if (!target || !source || source === target) return { mode: last.mode, amount: String(amount) };
  const converted = convertVolume(amount, source, target);
  if (converted === null) return { mode: last.mode, amount: null };
  const step = target === "mL" ? 5 : 0.5;
  return { mode: last.mode, amount: String(Number((Math.round(converted / step) * step).toFixed(2))) };
}
