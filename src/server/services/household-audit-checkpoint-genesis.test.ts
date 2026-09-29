import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// A restore refuses any household whose audit chain cannot be verified, and a checkpoint is what makes
// it verifiable. Two wrong fixes were attempted for the fresh-install case before the right one:
//
//   1. Treating an absent checkpoint as benign. WRONG: an absent checkpoint cannot be distinguished
//      from one deleted to hide a rewritten chain, and the integration rehearsal
//      (scripts/backup-recovery-rehearsal.integration.test.ts) correctly refused it.
//   2. Adding an explicit checkpoint write to household creation. REDUNDANT: writeAudit already upserts
//      the household checkpoint on every event, so a household is checkpointed by its own creation
//      events. The extra call restated an invariant writeAudit owns, and left the OTHER household
//      creation path (platform backup recovery) inconsistent by not having it.
//
// What actually holds the property is writeAudit's own checkpoint upsert. These tests pin that, because
// it is load-bearing for whether a freshly created household can receive a restore at all.

it("checkpoints the household inside writeAudit, so any audited household is verifiable", () => {
  const source = readFileSync("src/server/services/audit.ts", "utf8");
  // The upsert must follow the event write and use the same client, or a rollback could leave a
  // checkpoint describing an event that does not exist.
  expect(source).toMatch(/db\.auditEvent\.create\([\s\S]{0,900}db\.auditIntegrityCheckpoint\.upsert\(/);
  expect(source).toContain("scope: `household:${ctx.householdId}`");
});

it("counts the household's events for the checkpoint rather than assuming one", () => {
  const source = readFileSync("src/server/services/audit.ts", "utf8");
  expect(source).toContain("db.auditEvent.count({ where: { householdId: ctx.householdId } })");
});

it("does not let a restore accept an unverifiable chain", () => {
  const source = readFileSync("src/server/services/backups.ts", "utf8");
  // valid only. Any widening here re-opens the hole the rehearsal caught.
  expect(source).toContain('if (auditIntegrity.status !== "valid") {');
  expect(source).not.toContain("pristine");
});

it("keeps an absent checkpoint refused in the reader", () => {
  const source = readFileSync("src/server/services/audit-checkpoints.ts", "utf8");
  expect(source).toContain('if (!checkpoint) return { status: "missing" as const };');
  expect(source).not.toContain("pristine");
});
