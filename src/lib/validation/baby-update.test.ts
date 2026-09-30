import { describe, expect, it } from "vitest";
import { babyDeleteConfirmationPhrase, babyUpdateSchema } from "@/lib/validation/onboarding";

/**
 * These pin the schema properties the edit form depends on. Without them, someone could loosen the
 * schema to accept "" and the form tests would still pass while the original defect returned: an
 * emptied threshold box would reach the database as a rejected value rather than clearing the
 * warning.
 */
describe("editing a baby's details", () => {
  it("clears a threshold when it is sent as null", () => {
    expect(babyUpdateSchema.parse({ feedingWarningMinutes: null })).toEqual({
      feedingWarningMinutes: null
    });
  });

  it("refuses an empty string for a threshold, so the form must send null to clear it", () => {
    for (const field of [
      "feedingWarningMinutes",
      "diaperWarningMinutes",
      "sleepWarningMinutes"
    ] as const) {
      expect(() => babyUpdateSchema.parse({ [field]: "" })).toThrow();
    }
  });

  it("reads a typed number from the form as a number", () => {
    expect(babyUpdateSchema.parse({ feedingWarningMinutes: "45" })).toEqual({
      feedingWarningMinutes: 45
    });
  });

  it("refuses a threshold of zero or below, which would warn constantly", () => {
    expect(() => babyUpdateSchema.parse({ feedingWarningMinutes: "0" })).toThrow();
    expect(() => babyUpdateSchema.parse({ feedingWarningMinutes: -5 })).toThrow();
  });

  it("refuses a blank name, because absence and blankness are different", () => {
    expect(() => babyUpdateSchema.parse({ name: "" })).toThrow();
    expect(() => babyUpdateSchema.parse({ name: "   " })).toThrow();
    expect(babyUpdateSchema.parse({})).toEqual({});
  });

  it("refuses null for the fields that cannot be cleared", () => {
    for (const field of ["name", "birthDate", "notes"] as const) {
      expect(() => babyUpdateSchema.parse({ [field]: null })).toThrow();
    }
  });

  it("refuses a smuggled field, so a caller cannot reach a column the form does not offer", () => {
    expect(() => babyUpdateSchema.parse({ name: "Rosie", householdId: "household-2" })).toThrow();
    expect(() => babyUpdateSchema.parse({ name: "Rosie", deletedAt: null })).toThrow();
  });

  it("builds the confirmation phrase the server checks against the stored name", () => {
    expect(babyDeleteConfirmationPhrase("Sprout")).toBe("Yes Delete Baby Sprout");
  });
});
