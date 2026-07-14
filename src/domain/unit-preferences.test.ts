import { describe, expect, it } from "vitest";
import {
  defaultUnitPreferences,
  itemUnitPreference,
  parseUnitPreferences
} from "@/domain/unit-preferences";

describe("unit preferences", () => {
  it("uses US-oriented defaults when preferences are missing", () => {
    expect(parseUnitPreferences(undefined)).toEqual(defaultUnitPreferences);
  });

  it("accepts supported household and per-item units", () => {
    expect(
      parseUnitPreferences({
        volume: "mL",
        weight: "kg",
        length: "cm",
        temperature: "C",
        medicineUnits: { Acetaminophen: "mL" },
        supplementUnits: { "Vitamin D": "drops" }
      })
    ).toEqual({
      volume: "mL",
      weight: "kg",
      length: "cm",
      temperature: "C",
      medicineUnits: { Acetaminophen: "mL" },
      supplementUnits: { "Vitamin D": "drops" }
    });
  });

  it("fails closed to defaults for unsupported values or unknown fields", () => {
    expect(parseUnitPreferences({ ...defaultUnitPreferences, volume: "cups" })).toEqual(defaultUnitPreferences);
    expect(parseUnitPreferences({ ...defaultUnitPreferences, extra: true })).toEqual(defaultUnitPreferences);
    expect(
      parseUnitPreferences({
        ...defaultUnitPreferences,
        medicineUnits: { Acetaminophen: "" }
      })
    ).toEqual(defaultUnitPreferences);
  });

  it("normalizes item names for lookup while preserving configured display names", () => {
    const preferences = parseUnitPreferences({
      ...defaultUnitPreferences,
      medicineUnits: { "Infants' Tylenol": "mL" },
      supplementUnits: { "Vitamin D": "drops" }
    });

    expect(itemUnitPreference(preferences.medicineUnits, "  infants'   TYLENOL ")).toBe("mL");
    expect(itemUnitPreference(preferences.supplementUnits, "vitamin d")).toBe("drops");
    expect(Object.keys(preferences.medicineUnits)).toEqual(["Infants' Tylenol"]);
    expect(itemUnitPreference(preferences.medicineUnits, "Ibuprofen")).toBeUndefined();
  });
});
