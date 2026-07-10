import { describe, expect, it } from "vitest";
import { displayLabel } from "@/lib/display-label";

describe("displayLabel", () => {
  it.each([
    ["breast", "Breast"],
    ["woke early", "Woke Early"],
    ["milk_inventory", "Milk Inventory"],
    ["read_only", "Read Only"],
    ["1", "1"]
  ])("formats %s as %s", (value, expected) => {
    expect(displayLabel(value)).toBe(expected);
  });

  it("uses the empty label for an empty value", () => {
    expect(displayLabel("")).toBe("None");
    expect(displayLabel("", "Choose one")).toBe("Choose one");
  });
});
