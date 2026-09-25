import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression: BrowserOperationBinding_target_shape_check required "babyId" IS NOT NULL for the six
 * household-scoped activity operations, but issueHouseholdBrowserOperation records no babyId at all.
 * The constraint was therefore unsatisfiable, and editing an activity, deleting one, undoing the
 * last one, or pausing/resuming/stopping a timer failed with 23514 and surfaced as a 500 - in every
 * deployment, from 2026-08-18 until 20260917120000_activity_binding_baby_shape. No unit test caught
 * it because the service layer is exercised against mocks, where no CHECK constraint runs.
 *
 * This pins the two halves against each other cheaply, without Docker: whatever the code writes for
 * a household-scoped binding must be what the live constraint accepts.
 */
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

function currentTargetShapeConstraint() {
  const migrations = resolve(root, "prisma/migrations");
  const owning = readdirSync(migrations)
    .filter((name) => {
      try {
        return readFileSync(resolve(migrations, name, "migration.sql"), "utf8")
          .includes('ADD CONSTRAINT "BrowserOperationBinding_target_shape_check"');
      } catch {
        return false;
      }
    })
    .sort();
  const latest = owning.at(-1);
  expect(latest, "no migration defines BrowserOperationBinding_target_shape_check").toBeDefined();
  const sql = readFileSync(resolve(migrations, latest as string, "migration.sql"), "utf8");
  return sql.slice(sql.lastIndexOf('ADD CONSTRAINT "BrowserOperationBinding_target_shape_check"'));
}

// Issued by issueHouseholdBrowserOperation, which writes `babyId: null`.
const householdScopedKeys = [
  "activity.update",
  "activity.delete",
  "activity.undo_last",
  "activity.timer.pause",
  "activity.timer.resume",
  "activity.timer.stop",
  // Feed posts are household-scoped: a whole-family post has no baby.
  "feed_post.create",
  "feed_post.delete"
];

// Issued by issueBrowserOperation, which writes the baby it locked.
const babyScopedKeys = ["activity.create", "baby.deactivate", "baby.reactivate", "dashboard.warning.dismiss", "calendar_event.create", "planned_schedule.save"];

// Keys whose binding must record the thing they act on. notification.preference.save is here
// because 20260824120100 re-listed every case and silently reverted its clause to IS NULL, which
// made saving notification preferences unsatisfiable until 20260918120000 restored it.
const targetedKeys = [
  "activity.update",
  "activity.delete",
  "activity.undo_last",
  "activity.timer.stop",
  "notification.preference.save",
  "member.role.update",
  "member.suspend",
  "invite.revoke",
  "api_key.revoke",
  "feed_post.delete"
];

describe("browser operation binding target shape", () => {
  const constraint = currentTargetShapeConstraint();

  it("requires no babyId for the operations issued through the household path", () => {
    for (const key of householdScopedKeys) {
      const clause = constraint.match(new RegExp(`WHEN '${key.replace(/\./g, "\\.")}' THEN ([^\\n]+)`))?.[1];
      expect(clause, `${key} is missing from the constraint`).toBeDefined();
      expect(clause, `${key} must not demand a babyId the household path never records`).toContain('"babyId" IS NULL');
    }
  });

  it("still requires a babyId for the operations issued through the baby-scoped path", () => {
    for (const key of babyScopedKeys) {
      const clause = constraint.match(new RegExp(`WHEN '${key.replace(/\./g, "\\.")}' THEN ([^\\n]+)`))?.[1];
      expect(clause, `${key} is missing from the constraint`).toBeDefined();
      expect(clause, `${key} is baby-scoped and must keep recording its baby`).toContain('"babyId" IS NOT NULL');
    }
  });

  it("requires a target id wherever the code binds one", () => {
    for (const key of targetedKeys) {
      const clause = constraint.match(new RegExp(`WHEN '${key.replace(/\./g, "\\.")}' THEN ([^\\n]+)`))?.[1];
      expect(clause, `${key} is missing from the constraint`).toBeDefined();
      expect(clause, `${key} binds a target, so the constraint must require one`).toContain('"targetId" IS NOT NULL');
    }
  });

  it("keeps the code side of that contract explicit", () => {
    const source = read("src/server/services/browser-operations.ts");
    // The three places that make a household-scoped binding baby-less; if any of them starts
    // recording a babyId, the constraint above has to change with it.
    expect(source).toContain("babyId: null,");
    expect(source).toContain("binding.babyId === null;");
  });
});
