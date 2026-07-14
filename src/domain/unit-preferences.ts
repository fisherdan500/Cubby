import { z } from "zod";

const itemUnitsSchema = z.record(
  z.string().trim().min(1).max(100),
  z.string().trim().min(1).max(20)
);

export const unitPreferencesSchema = z
  .object({
    volume: z.enum(["oz", "mL"]).default("oz"),
    weight: z.enum(["lb", "kg"]).default("lb"),
    length: z.enum(["in", "cm"]).default("in"),
    temperature: z.enum(["F", "C"]).default("F"),
    medicineUnits: itemUnitsSchema.default({}),
    supplementUnits: itemUnitsSchema.default({})
  })
  .strict();

export type UnitPreferences = z.infer<typeof unitPreferencesSchema>;

export const defaultUnitPreferences: UnitPreferences = {
  volume: "oz",
  weight: "lb",
  length: "in",
  temperature: "F",
  medicineUnits: {},
  supplementUnits: {}
};

export function parseUnitPreferences(raw: unknown): UnitPreferences {
  const parsed = unitPreferencesSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return {
    ...defaultUnitPreferences,
    medicineUnits: {},
    supplementUnits: {}
  };
}

export function itemUnitPreference(units: Record<string, string>, name: string | null | undefined) {
  const normalizedName = normalizeItemName(name);
  if (!normalizedName) return undefined;
  const match = Object.entries(units).find(([itemName]) => normalizeItemName(itemName) === normalizedName);
  return match?.[1];
}

export function normalizeItemName(name: string | null | undefined) {
  return name?.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
