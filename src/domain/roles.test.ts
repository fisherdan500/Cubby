import { describe, expect, it } from "vitest";
import { HouseholdRole } from "@prisma/client";
import {
  canAssignHouseholdRole,
  canManageHouseholdRole,
  canMutateOwnOrAny,
  householdRoles,
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

  // The iterated list must stay the COMPLETE set of roles the database can hold, or the two rule
  // tests below would silently cover only part of it: a one-entry householdRoles satisfies their
  // non-emptiness witness just as well as the real five.
  it("iterates every role the database can actually store", () => {
    expect([...householdRoles].sort()).toEqual(Object.values(HouseholdRole).sort());
  });

  // The User's rule: "if a person can create a log then they should also be able to add a photo.
  // same rights as logs". Today activity.create and feed.post happen to be granted to the same
  // roles, so the product behaves correctly by coincidence of two separate lists. This pins the
  // rule itself, over every role including ones added later, so the coincidence cannot quietly end.
  // Each test counts the roles it actually checked and requires that count to be non-zero: without
  // that, deleting both permissions from every role would skip both loops and pass silently.
  it("lets anyone who can log an entry also attach a photo to it", () => {
    let checked = 0;
    for (const role of householdRoles) {
      if (!hasPermission(role, "activity.create")) continue;
      checked += 1;
      expect(hasPermission(role, "feed.post"), `${role} can log an entry but cannot attach a photo`).toBe(true);
    }
    expect(checked, "no role can log an entry, so the rule was never exercised").toBeGreaterThan(0);
  });

  it("does not let a photo be attached by someone who cannot log an entry", () => {
    let checked = 0;
    for (const role of householdRoles) {
      if (!hasPermission(role, "feed.post")) continue;
      checked += 1;
      expect(hasPermission(role, "activity.create"), `${role} can attach a photo but cannot log an entry`).toBe(true);
    }
    expect(checked, "no role can attach a photo, so the rule was never exercised").toBeGreaterThan(0);
  });

  // The same rule stated as the set equality it really is. The two loops above name one offending
  // role per run; this names every mismatch at once. It needs the loops' witness to stay honest,
  // since two empty sets are equal -- so these three tests are kept together deliberately.
  it("grants logging and photo rights to exactly the same roles", () => {
    const canLog = householdRoles.filter((role) => hasPermission(role, "activity.create"));
    const canAttach = householdRoles.filter((role) => hasPermission(role, "feed.post"));
    expect(canAttach).toEqual(canLog);
  });
});
