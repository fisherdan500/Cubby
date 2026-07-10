import { describe, expect, it } from "vitest";
import {
  canAssignHouseholdRole,
  canManageHouseholdRole,
  canMutateOwnOrAny,
  hasPermission
} from "@/domain/roles";

describe("role permissions", () => {
  it("lets owners manage household data", () => {
    expect(hasPermission("owner", "household.manage")).toBe(true);
    expect(hasPermission("owner", "admin.manage")).toBe(true);
    expect(hasPermission("owner", "export.create")).toBe(true);
  });

  it("gives admins operational administration without owner control", () => {
    expect(hasPermission("admin", "household.manage")).toBe(true);
    expect(hasPermission("admin", "member.manage")).toBe(true);
    expect(hasPermission("admin", "integration.manage")).toBe(true);
    expect(hasPermission("admin", "backup.manage")).toBe(true);
    expect(hasPermission("admin", "admin.manage")).toBe(false);
  });

  it("keeps parents out of member and administrative settings", () => {
    expect(hasPermission("parent", "baby.manage")).toBe(true);
    expect(hasPermission("parent", "notification.manage")).toBe(true);
    expect(hasPermission("parent", "invite.create")).toBe(false);
    expect(hasPermission("parent", "member.manage")).toBe(false);
    expect(hasPermission("parent", "household.manage")).toBe(false);
    expect(hasPermission("parent", "backup.manage")).toBe(false);
  });

  it("limits caretakers to own activity mutations", () => {
    expect(canMutateOwnOrAny("caretaker", "update", true)).toBe(true);
    expect(canMutateOwnOrAny("caretaker", "update", false)).toBe(false);
  });

  it("keeps read-only members from writing", () => {
    expect(hasPermission("read_only", "activity.read")).toBe(true);
    expect(hasPermission("read_only", "activity.create")).toBe(false);
  });

  it("lets every household role manage only their personal sessions", () => {
    for (const role of ["owner", "admin", "parent", "caretaker", "read_only"] as const) {
      expect(hasPermission(role, "session.manage")).toBe(true);
    }
  });

  it("protects owner and admin role assignment", () => {
    expect(canAssignHouseholdRole("owner", "admin")).toBe(true);
    expect(canAssignHouseholdRole("admin", "admin")).toBe(false);
    expect(canAssignHouseholdRole("admin", "parent")).toBe(true);
    expect(canAssignHouseholdRole("parent", "caretaker")).toBe(false);
    expect(canManageHouseholdRole("owner", "owner")).toBe(false);
    expect(canManageHouseholdRole("owner", "admin")).toBe(true);
    expect(canManageHouseholdRole("admin", "admin")).toBe(false);
    expect(canManageHouseholdRole("admin", "parent")).toBe(true);
  });
});
