import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { HouseholdRole } from "@prisma/client";
import {
  canAssignHouseholdRole,
  canManageHouseholdRole,
  canMutateOwnOrAny,
  householdRoles,
  hasPermission,
  type Permission
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

  it("keeps read-only members from changing activity", () => {
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

  // The converse is deliberately NOT required. The User's rule runs one way only -- "if a person can
  // create a log then they should also be able to add a photo" -- and read_only now holds feed.post
  // without activity.create, because a relative may post a photo to Moments but may not record a
  // feeding. Posting to the family feed and caretaking are different acts. Asserting set equality
  // here was a strengthening of the rule that the product has now outgrown.
  it("lets a role post to the feed without being able to log an entry", () => {
    expect(hasPermission("read_only", "feed.post")).toBe(true);
    expect(hasPermission("read_only", "activity.create")).toBe(false);
  });

  // The same rule stated as the set equality it really is. The two loops above name one offending
  // role per run; this names every mismatch at once. It needs the loops' witness to stay honest,
  // since two empty sets are equal -- so these three tests are kept together deliberately.
  it("gives every logger photo rights, and allows posters who are not loggers", () => {
    const canLog = householdRoles.filter((role) => hasPermission(role, "activity.create"));
    const canAttach = householdRoles.filter((role) => hasPermission(role, "feed.post"));
    expect(canLog.length, "no role can log an entry, so the rule was never exercised").toBeGreaterThan(0);
    for (const role of canLog) expect(canAttach).toContain(role);
    expect(canAttach).toContain("read_only");
    // The old set equality was the only alarm against over-granting feed.post. Relaxing it to one
    // direction removed that alarm, so the exception is pinned explicitly instead: read_only is the
    // single role that may post without being able to log, and any future addition must be
    // deliberate rather than silent.
    expect(canAttach.filter((role) => !canLog.includes(role))).toEqual(["read_only"]);
  });
});

const allPermissions = (() => {
  // Read from source so a permission added to the union is automatically covered below; an
  // inlined copy would quietly stop testing new permissions.
  const source = readFileSync("src/domain/roles.ts", "utf8");
  const union = source.slice(source.indexOf("export type Permission ="));
  return [...new Set(union.slice(0, union.indexOf(";")).match(/"[a-z.]+"/g)!.map((q) => q.slice(1, -1)))] as Permission[];
})();

describe("a relative's permissions are pinned exactly", () => {
  // An independent review showed that adding "export.create" to read_only -- letting a relative
  // export the household's entire activity log -- passed the whole suite, as did granting
  // notification.manage and integration.manage (API keys and webhooks). Nothing asserted the set,
  // only individual members of it. Driven off the full Permission union so a newly added
  // permission must be classified here deliberately rather than landing on a relative silently.
  const granted = ["activity.read", "feed.comment", "feed.post", "session.manage"] as const;

  it("grants exactly what the User decided", () => {
    for (const permission of granted) {
      expect(hasPermission("read_only", permission), permission).toBe(true);
    }
  });

  it("withholds every other permission in the system", () => {
    const withheld = allPermissions.filter((permission) => !granted.includes(permission as never));
    expect(withheld.length).toBeGreaterThan(0);
    for (const permission of withheld) {
      expect(hasPermission("read_only", permission), permission).toBe(false);
    }
  });
});
