import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// A restore refuses any household whose audit chain cannot be verified, and a checkpoint is what makes
// it verifiable. Checkpoints were only ever written by the scheduled integrity sweep, so a household
// created a minute ago had none and could not receive a restore -- which is exactly the state a
// migration onto a new server starts from.
//
// Fixing that by treating an absent checkpoint as benign was WRONG: an absent checkpoint is
// indistinguishable from one deleted to hide a rewritten chain, and the integration rehearsal
// (scripts/backup-recovery-rehearsal.integration.test.ts) correctly failed that attempt. The household
// is checkpointed at creation instead, so it is verifiable from its first moment and the tamper signal
// keeps its meaning.

it("checkpoints a household when it is created, inside the creating transaction", () => {
  const source = readFileSync("src/server/services/households.ts", "utf8");
  expect(source).toContain("refreshHouseholdAuditCheckpoint");
  // Must be in the same transaction as the creation and its two audit events, or a crash in between
  // leaves a household that exists but cannot be restored onto.
  expect(source).toMatch(/action: "baby\.create"[\s\S]{0,900}refreshHouseholdAuditCheckpoint\(created\.id, tx\)/);
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
