import type { UnitPreferences } from "@/domain/unit-preferences";

export type VolumeUnit = UnitPreferences["volume"];
export type WeightUnit = UnitPreferences["weight"];
export type LengthUnit = UnitPreferences["length"];

const millilitersPerOunce = 29.5735295625;
const kilogramsPerPound = 0.45359237;
const centimetersPerInch = 2.54;

export function convertVolume(amount: number, from: string | null | undefined, to: VolumeUnit) {
  if (!Number.isFinite(amount)) return null;
  const source = normalizeVolumeUnit(from ?? "oz");
  if (!source) return null;
  if (source === to) return amount;
  return source === "oz" ? amount * millilitersPerOunce : amount / millilitersPerOunce;
}

export function sumVolume(
  entries: Array<{ amount: number; unit?: string | null }>,
  unit: VolumeUnit
): { amount: number | null; unit: VolumeUnit; complete: boolean } {
  let amount = 0;
  for (const entry of entries) {
    const converted = convertVolume(entry.amount, entry.unit, unit);
    if (converted === null) return { amount: null, unit, complete: false };
    amount += converted;
  }
  return { amount, unit, complete: true };
}

export function convertWeight(amount: number, from: string | null | undefined, to: WeightUnit) {
  if (!Number.isFinite(amount)) return null;
  const source = normalizeWeightUnit(from ?? "lb");
  if (!source) return null;
  if (source === to) return amount;
  return source === "lb" ? amount * kilogramsPerPound : amount / kilogramsPerPound;
}

export function convertLength(amount: number, from: string | null | undefined, to: LengthUnit) {
  if (!Number.isFinite(amount)) return null;
  const source = normalizeLengthUnit(from ?? "in");
  if (!source) return null;
  if (source === to) return amount;
  return source === "in" ? amount * centimetersPerInch : amount / centimetersPerInch;
}

function normalizeVolumeUnit(unit: string): VolumeUnit | null {
  const normalized = unit.trim().toLocaleLowerCase("en-US").replace(/\./g, "");
  if (["oz", "fl oz", "floz", "ounce", "ounces"].includes(normalized)) return "oz";
  if (["ml", "milliliter", "milliliters", "millilitre", "millilitres"].includes(normalized)) return "mL";
  return null;
}

function normalizeWeightUnit(unit: string): WeightUnit | null {
  const normalized = unit.trim().toLocaleLowerCase("en-US").replace(/\./g, "");
  if (["lb", "lbs", "pound", "pounds"].includes(normalized)) return "lb";
  if (["kg", "kilogram", "kilograms", "kilogramme", "kilogrammes"].includes(normalized)) return "kg";
  return null;
}

function normalizeLengthUnit(unit: string): LengthUnit | null {
  const normalized = unit.trim().toLocaleLowerCase("en-US").replace(/\./g, "");
  if (["in", "inch", "inches"].includes(normalized)) return "in";
  if (["cm", "centimeter", "centimeters", "centimetre", "centimetres"].includes(normalized)) return "cm";
  return null;
}
