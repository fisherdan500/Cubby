import { describe, expect, it } from "vitest";
import { canMutateOwnOrAny, hasPermission } from "@/domain/roles";

describe("role permissions", () => {
  it("lets owners manage household data", () => {
    expect(hasPermission("owner", "household.manage")).toBe(true);
    expect(hasPermission("owner", "export.create")).toBe(true);
  });

  it("limits caretakers to own activity mutations", () => {
    expect(canMutateOwnOrAny("caretaker", "update", true)).toBe(true);
    expect(canMutateOwnOrAny("caretaker", "update", false)).toBe(false);
  });

  it("keeps read-only members from writing", () => {
    expect(hasPermission("read_only", "activity.read")).toBe(true);
    expect(hasPermission("read_only", "activity.create")).toBe(false);
  });
});
