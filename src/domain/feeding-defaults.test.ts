import { describe, expect, it } from "vitest";
import { feedingFormStart } from "@/domain/feeding-defaults";

describe("feedingFormStart", () => {
  it("starts a new feed as the last one was: its kind, and the last bottle or formula amount", () => {
    expect(feedingFormStart({ mode: "formula", amount: "4.5", unit: "oz" }, "oz")).toEqual({ mode: "formula", amount: "4.5" });
    // After a breastfeed the kind is breast; the amount waits for the next bottle.
    expect(feedingFormStart({ mode: "breast", amount: "4", unit: "oz" }, "oz")).toEqual({ mode: "breast", amount: "4" });
  });

  it("converts the amount when the household's volume unit has changed since, to the stepper's step", () => {
    // 4 oz is 118.3 mL: the nearest 5 mL step is 120.
    expect(feedingFormStart({ mode: "bottle", amount: "4", unit: "oz" }, "mL")).toEqual({ mode: "bottle", amount: "120" });
    // 125 mL is 4.23 oz: the nearest half ounce is 4.
    expect(feedingFormStart({ mode: "bottle", amount: "125", unit: "mL" }, "oz")).toEqual({ mode: "bottle", amount: "4" });
  });

  it("starts as a bottle with no amount when there is no feed to go by", () => {
    expect(feedingFormStart(null, "oz")).toEqual({ mode: "bottle", amount: null });
    expect(feedingFormStart({ mode: "solids", amount: null, unit: null }, "oz")).toEqual({ mode: "solids", amount: null });
  });
});
