import { describe, expect, it } from "vitest";
import { convertVolume, sumVolume } from "@/domain/units";

describe("volume conversion", () => {
  it("converts between ounces and milliliters in both directions", () => {
    expect(convertVolume(1, "oz", "mL")).toBeCloseTo(29.5735, 4);
    expect(convertVolume(29.5735, "mL", "oz")).toBeCloseTo(1, 4);
  });

  it("preserves same-unit values and accepts common stored spellings", () => {
    expect(convertVolume(4.25, "fl oz", "oz")).toBe(4.25);
    expect(convertVolume(120, "ml", "mL")).toBe(120);
  });

  it("fails closed for unsupported or invalid values", () => {
    expect(convertVolume(2, "cups", "oz")).toBeNull();
    expect(convertVolume(Number.NaN, "oz", "mL")).toBeNull();
  });

  it("sums mixed units into the requested unit without rounding intermediate values", () => {
    expect(sumVolume([
      { amount: 1, unit: "oz" },
      { amount: 29.5735, unit: "mL" }
    ], "mL")).toEqual({ amount: expect.closeTo(59.147, 3), unit: "mL", complete: true });
  });

  it("marks a total incomplete instead of mixing unsupported units", () => {
    expect(sumVolume([
      { amount: 1, unit: "oz" },
      { amount: 2, unit: "cups" }
    ], "oz")).toEqual({ amount: null, unit: "oz", complete: false });
  });
});
