import { describe, expect, it } from "vitest";
import {
  hasActivityDetail,
  resolveActivityUnit,
  resolveFormUnit,
  resolveItemDoseUnit
} from "@/lib/activity-form";

describe("hasActivityDetail", () => {
  it("returns false when optional fields have no saved value", () => {
    expect(hasActivityDetail(undefined, ["location"])).toBe(false);
    expect(hasActivityDetail({ location: "", concern: false, note: null }, ["location", "concern", "note"])).toBe(false);
  });

  it("returns true for saved text, numeric zero, or enabled flags", () => {
    expect(hasActivityDetail({ location: "Nursery" }, ["location"])).toBe(true);
    expect(hasActivityDetail({ amount: 0 }, ["amount"])).toBe(true);
    expect(hasActivityDetail({ blowout: true }, ["blowout"])).toBe(true);
  });
});

describe("activity unit defaults", () => {
  it("uses saved, preferred, then built-in units in that order", () => {
    expect(resolveActivityUnit({ saved: "mL", preferred: "oz", fallback: "oz" })).toBe("mL");
    expect(resolveActivityUnit({ preferred: "mL", fallback: "oz" })).toBe("mL");
    expect(resolveActivityUnit({ fallback: "oz" })).toBe("oz");
  });

  it("ignores blank saved and preferred units", () => {
    expect(resolveActivityUnit({ saved: " ", preferred: "", fallback: "lb" })).toBe("lb");
  });

  it("keeps a persisted blank unit blank while defaults apply only to new activity", () => {
    expect(resolveFormUnit({ editing: true, saved: null, preferred: "mL", fallback: "oz" })).toBe("");
    expect(resolveFormUnit({ editing: false, saved: null, preferred: "mL", fallback: "oz" })).toBe("mL");
  });

  it("uses only the matching named item default", () => {
    const units = { Acetaminophen: "mL", Ibuprofen: "tablet" };

    expect(resolveItemDoseUnit({ name: " acetaminophen ", units })).toBe("mL");
    expect(resolveItemDoseUnit({ name: "Unknown", units })).toBe("");
    expect(resolveItemDoseUnit({ saved: "drops", name: "Acetaminophen", units })).toBe("drops");
  });
});
