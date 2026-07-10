import { describe, expect, it } from "vitest";
import { hasActivityDetail } from "@/lib/activity-form";

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
