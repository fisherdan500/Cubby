import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { navForRole } from "@/components/app-shell";
import { hasPermission, type HouseholdRoleName } from "@/domain/roles";

/**
 * What a relative sees when they open Cubby.
 *
 * `read_only` existed in the schema and in both invitation forms long before anything downstream
 * honoured it: the navigation was a module constant with no role awareness, so a grandparent's
 * first screen was "Log Entry" -- the app's landing route, a form for recording a diaper change.
 * The role was a label, not a behaviour.
 *
 * The User's decision (2026-10-22) is that a relative sees Moments: photos and milestones, not
 * feeding and sleep statistics. These tests pin that, and pin it against the PERMISSION rather than
 * the role name, so a future role that cannot log entries is treated correctly without anyone
 * remembering to add it here.
 */
describe("the navigation a relative is given", () => {
  const roles: HouseholdRoleName[] = ["owner", "admin", "parent", "caretaker", "read_only"];

  it("offers a relative exactly one destination, and it is Moments", () => {
    const items = navForRole("read_only");
    expect(items.map((item) => item.href)).toEqual(["/app/moments"]);
  });

  it("never offers a relative the entry form", () => {
    // The specific regression: "Log Entry" is the first nav item and the app's landing route, so a
    // relative's first screen was a form they cannot submit.
    const hrefs = navForRole("read_only").map((item) => item.href);
    expect(hrefs).not.toContain("/app");
  });

  it.each(["owner", "admin", "parent", "caretaker"] as const)(
    "leaves %s's navigation complete",
    (role) => {
      const hrefs = navForRole(role).map((item) => item.href);
      expect(hrefs).toEqual(["/app", "/app/moments", "/app/history", "/app/calendar", "/app/reports"]);
    }
  );

  it("shows every member Moments", () => {
    for (const role of roles) {
      expect(navForRole(role).map((item) => item.href), role).toContain("/app/moments");
    }
  });

  it("hides exactly the destinations a role cannot use, no more", () => {
    // Guards against over-filtering: a caretaker can log entries, so nothing should be hidden from
    // them, and a relative should lose only what they genuinely cannot do.
    for (const role of roles) {
      const canLog = hasPermission(role, "activity.create");
      const hrefs = navForRole(role).map((item) => item.href);
      expect(hrefs.includes("/app"), `${role} log entry`).toBe(canLog);
      expect(hrefs.includes("/app/history"), `${role} full log`).toBe(canLog);
      expect(hrefs.includes("/app/calendar"), `${role} calendar`).toBe(canLog);
      expect(hrefs.includes("/app/reports"), `${role} reports`).toBe(canLog);
    }
  });

  it("falls back to the full navigation when no role is known", () => {
    // Screens that are not household-scoped (onboarding, recovery) pass no role; they must not
    // silently lose their navigation.
    expect(navForRole(undefined).map((item) => item.href)).toHaveLength(5);
  });

  it("gates on the permission, not on the role name", () => {
    // If this is ever rewritten as `role === "read_only"`, a future non-logging role would get the
    // full parent navigation and screens that refuse it.
    const source = readFileSync("src/components/app-shell.tsx", "utf8");
    expect(source).toMatch(/hasPermission\(role, item\.requires\)/);
    expect(source).not.toMatch(/role === "read_only"/);
  });
});

describe("the screens a relative cannot reach by typing the URL", () => {
  // Hiding a link is not a guard. Each of these pages must redirect, not merely be unlinked.
  it.each([
    ["src/app/app/page.tsx", "the entry form"],
    ["src/app/app/history/page.tsx", "the full log"],
    ["src/app/app/calendar/page.tsx", "the calendar"],
    ["src/app/app/reports/page.tsx", "the reports"]
  ])("%s redirects a relative away from %s", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(/hasPermission\([^)]*"activity\.create"\)\) redirect\("\/app\/moments"\)/);
  });
});

describe("what a relative may do in Moments", () => {
  // The User's decision (2026-10-22): "comment, post and react". A relative is family, not an
  // audience. They still cannot LOG an entry -- posting a photo and recording a feeding are
  // different acts, and only the second is caretaking.
  it("lets a relative post, comment and react", () => {
    expect(hasPermission("read_only", "feed.post")).toBe(true);
    expect(hasPermission("read_only", "feed.comment")).toBe(true);
  });

  it("still does not let a relative log an entry or manage anything", () => {
    for (const permission of [
      "activity.create",
      "activity.update.own",
      "activity.delete.own",
      "baby.manage",
      "member.manage",
      "household.manage",
      "invite.create",
      "feed.moderate"
    ] as const) {
      expect(hasPermission("read_only", permission), permission).toBe(false);
    }
  });

  it("lets a relative read what is already logged", () => {
    // They see Moments by decision, but activity.read is what makes the feed's entries visible at
    // all; revoking it would empty their one screen.
    expect(hasPermission("read_only", "activity.read")).toBe(true);
  });
});

describe("the phone's bottom tabs", () => {
  // A phone has no sidebar: the bottom bar is the only chrome, so an unfiltered Log tab there is
  // the same defect as an unfiltered sidebar — and it was invisible to the tests above, which only
  // exercised the desktop nav. Sabotage caught this.
  const source = readFileSync("src/components/mobile-bottom-nav.tsx", "utf8");

  it("filters the tabs by permission rather than showing all of them", () => {
    expect(source).toMatch(/const tabs = role \?[\s\S]{0,200}hasPermission\(role, item\.requires\)/);
    expect(source).not.toMatch(/const tabs = mobileNav;/);
  });

  it("declares the Log tab as needing activity.create, and Moments as needing nothing", () => {
    expect(source).toMatch(/href: "\/app", label: "Log"[^}]*requires: "activity\.create"/);
    expect(source).toMatch(/href: "\/app\/moments", label: "Moments"[^}]*requires: null/);
  });

  it("hides the Full Log row behind More from anyone who cannot log", () => {
    expect(source).toMatch(/canSeeFullLog/);
    expect(source).toMatch(/hasPermission\(role, "activity\.create"\)/);
  });

  it("derives the tab grid width instead of hardcoding five columns", () => {
    // With a tab removed, grid-cols-5 would leave a visible gap where Log used to be.
    expect(source).not.toMatch(/grid grid-cols-5/);
    expect(source).toMatch(/gridColumns/);
  });

  it("gates on the permission, not on the role name", () => {
    expect(source).not.toMatch(/role === "read_only"/);
  });
});
