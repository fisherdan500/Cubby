import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260817180000_household_browser_operation_foundation";
const migrationUrl = new URL(`../../../prisma/migrations/${migrationDirectory}/migration.sql`, import.meta.url);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);
const backupFormatUrl = new URL("./backup-format.ts", import.meta.url);

function block(source: string, kind: "model" | "enum", name: string) {
  return source
    .split(new RegExp(`\\r?\\n(?=${kind}\\s)`))
    .find((candidate) => candidate.startsWith(`${kind} ${name} `)) ?? "";
}

const householdOperationKeys = [
  "activity.create",
  "activity.update",
  "activity.delete",
  "activity.undo_last",
  "activity.timer.pause",
  "activity.timer.resume",
  "activity.timer.stop",
  "baby.create",
  "baby.deactivate",
  "baby.reactivate",
  "dashboard.warning.dismiss",
  "invite.create",
  "invite.revoke",
  "invite.revoke_all",
  "member.restore",
  "member.remove",
  "member.role.update",
  "member.suspend",
  "notification.preference.save",
  "settings.units.update",
  "calendar_event.create",
  "household.accent.update"
] as const;

describe("generalized household browser-operation foundation migration", () => {
  it("declares exactly the 22 household keys and a closed target discriminator without account scope", () => {
    const schema = readFileSync(schemaUrl, "utf8");
    const operationKeys = block(schema, "enum", "BrowserOperationKey");
    const targetKinds = block(schema, "enum", "BrowserOperationTargetKind");

    for (const key of householdOperationKeys) expect(operationKeys).toContain(`@map("${key}")`);
    expect(operationKeys.match(/@map\("[^"]+"\)/g)).toHaveLength(22);
    expect(operationKeys).not.toContain("account.appearance.update");
    for (const kind of ["household", "activity", "baby", "warning", "invite", "member", "preference", "settings", "calendar"]) {
      expect(targetKinds).toMatch(new RegExp(`\\b${kind}\\b`));
    }
  });

  it("models payload-free opening bindings, set-once submit intent, and lifetime household tombstones", () => {
    const schema = readFileSync(schemaUrl, "utf8");
    const binding = block(schema, "model", "BrowserOperationBinding");
    const operation = block(schema, "model", "BrowserMutationOperation");
    const tombstone = block(schema, "model", "BrowserMutationOperationTombstone");

    expect(binding).toMatch(/openingFingerprint\s+String\?/);
    expect(binding).toMatch(/legacyIntentFingerprint\s+String\?\s+@map\("intentFingerprint"\)/);
    expect(binding).toMatch(/persistenceVersion\s+Int\s+@default\(1\)/);
    expect(binding).toMatch(/targetKind\s+BrowserOperationTargetKind\?/);
    expect(binding).toMatch(/targetId\s+String\?/);
    expect(binding).toMatch(/targetSnapshot\s+Json\?/);

    expect(operation).toMatch(/openingFingerprint\s+String\?/);
    expect(operation).toMatch(/intentFingerprint\s+String/);
    expect(operation).toMatch(/bindingId\s+String\s+@unique/);
    expect(operation).toMatch(/targetKind\s+BrowserOperationTargetKind\?/);
    expect(operation).toMatch(/targetId\s+String\?/);

    for (const field of [
      "householdId", "operationId", "operationKey", "actorUserId", "actorMemberId",
      "intentFingerprint", "terminalStatus", "terminalCode", "createdAt", "terminalAt",
      "compactedAt", "auditCorrelation"
    ]) expect(tombstone).toMatch(new RegExp(`\\b${field}\\b`));
    expect(tombstone).toContain("@@id([householdId, operationId])");
    expect(tombstone).not.toMatch(/outcomeSnapshot|openingFingerprint|targetSnapshot|request|payload|error/);
  });

  it("adds a deterministic fail-closed forward migration with database-enforced identity and state guards", () => {
    expect(existsSync(migrationUrl)).toBe(true);
    if (!existsSync(migrationUrl)) return;
    const migration = readFileSync(migrationUrl, "utf8");

    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("COMMIT;");
    expect(migration).toContain("browser_operation_foundation_preflight_failed:");
    expect(migration).toContain('CREATE TABLE "BrowserMutationOperationTombstone"');
    expect(migration).toContain('BrowserOperationBinding_target_shape_check');
    expect(migration).toContain('BrowserOperationBinding_two_stage_check');
    expect(migration).toContain('BrowserMutationOperation_two_stage_check');
    expect(migration).toContain('BrowserMutationOperation_state_check');
    expect(migration).toContain('lock_household_browser_operation_identity');
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain('guard_household_browser_operation_binding_insert');
    expect(migration).toContain('guard_household_browser_mutation_operation_insert');
    expect(migration).toContain('guard_household_browser_operation_tombstone_insert');
    expect(migration).toContain('enforce_browser_operation_binding_write_once');
    expect(migration).toContain('enforce_browser_mutation_operation_transition');
    expect(migration).toContain('compact_household_browser_operation');
    expect(migration).toContain('terminal_browser_mutation_operation_immutable');
    expect(migration).toContain("browser_operation_tombstone_immutable");
    expect(migration).not.toContain('NEW."operationId""');
    expect(migration).toContain("Existing browser_v1 and persistenceVersion 1 rows are not rewritten or reinterpreted");
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("keeps operation infrastructure out of ordinary logical household backups", () => {
    const backupFormat = readFileSync(backupFormatUrl, "utf8");
    expect(backupFormat).toContain("Browser operation bindings, receipts, tombstones, and integrity state");
  });
});
