import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Undo-last reads the activity it may undo out of the audit entry the create/delete wrote, using
 * updatedAt as the revision it is allowed to act on. auditActivityPayload never wrote that field and
 * auditActivityState returns null without it, so every activity looked like an unknown revision and
 * the Undo last button failed for every activity in every deployment.
 *
 * The submit path also demanded an activityId the button cannot know - the issue step picks the
 * target itself and the client only gets an operation id back - so the request was rejected before
 * it got that far.
 *
 * Both halves are pinned here because they live in different files and neither one is wrong alone.
 */
const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("activity audit revision contract", () => {
  const activities = read("src/server/services/activities.ts");
  const audit = read("src/server/services/audit.ts");

  it("writes the revision the undo path reads back", () => {
    expect(activities).toContain("activity.updatedAt.toISOString()");
    expect(activities).toMatch(/function auditActivityState[\s\S]{0,400}value\.updatedAt/);
  });

  it("lets the minimized audit payload carry that revision", () => {
    expect(audit).toMatch(/activityAuditPayloadSchema = z\.object\(\{[\s\S]{0,600}updatedAt: z\.string\(\)\.datetime\(\)\.optional\(\)/);
    // Still strict: the point is one deliberate field, not an open payload.
    expect(audit).toMatch(/activityAuditPayloadSchema = z\.object\(\{[\s\S]{0,700}\}\)\.strict\(\);/);
  });

  it("does not require an activityId the caller cannot know", () => {
    const submit = activities.slice(activities.indexOf("export async function submitActivityUndoLastBrowserOperation"));
    expect(submit.slice(0, 2000)).not.toContain('requiredActivityBrowserId(record, "activityId")');
    expect(submit.slice(0, 2000)).toContain("undoLastBindingTarget");
  });
});
