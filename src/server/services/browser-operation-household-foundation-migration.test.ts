import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260817180000_household_browser_operation_foundation";
const migrationUrl = new URL(`../../../prisma/migrations/${migrationDirectory}/migration.sql`, import.meta.url);
const enumMigrationUrl = new URL("../../../prisma/migrations/20260817170000_browser_operation_key_expansion/migration.sql", import.meta.url);
const reservationMigrationUrl = new URL("../../../prisma/migrations/20260819170000_browser_operation_reservation_tombstones/migration.sql", import.meta.url);
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
  "household.accent.update",
  "api_key.revoke"
] as const;

describe("generalized household browser-operation foundation migration", () => {
  it("declares exactly the 23 household keys and a closed target discriminator without account scope", () => {
    const schema = readFileSync(schemaUrl, "utf8");
    const operationKeys = block(schema, "enum", "BrowserOperationKey");
    const targetKinds = block(schema, "enum", "BrowserOperationTargetKind");

    for (const key of householdOperationKeys) expect(operationKeys).toContain(`@map("${key}")`);
    expect(operationKeys.match(/@map\("[^"]+"\)/g)).toHaveLength(23);
    expect(operationKeys).not.toContain("account.appearance.update");
    for (const kind of ["household", "activity", "baby", "warning", "invite", "member", "preference", "settings", "calendar", "apiKey"]) {
      expect(targetKinds).toMatch(new RegExp(`\\b${kind}\\b`));
    }
  });

  it("models payload-free opening bindings, set-once submit intent, and lifetime household tombstones", () => {
    const schema = readFileSync(schemaUrl, "utf8");
    const binding = block(schema, "model", "BrowserOperationBinding");
    const operation = block(schema, "model", "BrowserMutationOperation");
    const tombstone = block(schema, "model", "BrowserMutationOperationTombstone");
    const reservationTombstone = block(schema, "model", "BrowserOperationReservationTombstone");
    const accountReservationTombstone = block(schema, "model", "AccountOperationReservationTombstone");

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

    for (const field of ["householdId", "operationId", "operationKey", "sessionId", "actorUserId", "actorMemberId", "openingFingerprint", "terminalCode", "createdAt", "terminalAt"]) {
      expect(reservationTombstone).toMatch(new RegExp(`\\b${field}\\b`));
    }
    expect(reservationTombstone).toContain("@@id([householdId, operationId])");
    expect(reservationTombstone).not.toMatch(/session\s+Session|@relation\([^\n]*sessionId/);
    expect(reservationTombstone).not.toMatch(/intentFingerprint|outcomeSnapshot|targetSnapshot|request|payload|error/);

    for (const field of ["userId", "operationId", "operationKey", "sessionId", "openingFingerprint", "terminalCode", "createdAt", "terminalAt"]) {
      expect(accountReservationTombstone).toMatch(new RegExp(`\\b${field}\\b`));
    }
    expect(accountReservationTombstone).toContain("@@id([userId, operationId])");
    expect(accountReservationTombstone).not.toMatch(/session\s+Session|@relation\([^\n]*sessionId/);
  });

  it("adds a forward-only reservation-tombstone migration that guards household and account identity reuse", () => {
    expect(existsSync(reservationMigrationUrl)).toBe(true);
    if (!existsSync(reservationMigrationUrl)) return;
    const migration = readFileSync(reservationMigrationUrl, "utf8");
    for (const table of ["BrowserOperationReservationTombstone", "AccountOperationReservationTombstone"]) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }
    expect(migration).toContain("browser_operation_reservation_identity_already_owned");
    expect(migration).toContain("account_operation_reservation_identity_already_owned");
    expect(migration).toContain("browser_operation_reservation_tombstone_immutable");
    expect(migration).toContain("account_operation_reservation_tombstone_immutable");
    expect(migration).toContain('"sessionId" TEXT NOT NULL');
    expect(migration).not.toMatch(/FOREIGN KEY \("sessionId"\)/);
    expect(migration).toContain('guard_browser_operation_reservation_tombstone_insert');
    expect(migration).toContain('guard_account_operation_reservation_tombstone_insert');
    expect(migration).toContain('browser_operation_reservation_tombstone_binding_mismatch');
    expect(migration).toContain('account_operation_reservation_tombstone_binding_mismatch');
    for (const field of ["operationKey", "sessionId", "actorUserId", "actorMemberId", "openingFingerprint", "issuedAt"]) {
      expect(migration).toContain(`binding."${field}" = NEW."${field === "issuedAt" ? "createdAt" : field}"`);
      expect(migration).toContain(`tombstone."${field === "issuedAt" ? "createdAt" : field}" = OLD."${field}"`);
    }
    expect(migration).toContain('binding."userId" = NEW."userId"');
    expect(migration).toContain('tombstone."userId" = OLD."userId"');
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM "BrowserMutationOperation" operation WHERE operation."bindingId" = binding."id")');
    expect(migration).toContain('NOT EXISTS (SELECT 1 FROM "AccountMutationOperation" operation WHERE operation."bindingId" = binding."id")');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION "enforce_browser_operation_binding_write_once"');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION "enforce_account_operation_binding_write_once"');
    expect(migration).not.toContain('IF OLD."persistenceVersion" <> 2 THEN RETURN NEW; END IF;');
    expect(migration).toContain('OLD."persistenceVersion"');
    expect(migration).toContain('NEW."persistenceVersion"');
    expect(migration).toContain('BrowserOperationReservationTombstone" tombstone');
    expect(migration).toContain('tombstone."householdId" = OLD."householdId"');
    expect(migration).toContain('AccountOperationReservationTombstone" tombstone');
    expect(migration).toContain('tombstone."userId" = OLD."userId"');
    expect(migration).toContain("browser_operation_binding_transition_invalid");
    expect(migration).toContain("browser_operation_submitted_without_operation");
    expect(migration).toContain("browser_operation_terminal_without_terminal_operation");
    expect(migration).toContain("account_operation_binding_transition_invalid");
    expect(migration).toContain("account_operation_submitted_without_operation");
    expect(migration).toContain("account_operation_terminal_without_terminal_operation");
  });

  it("adds a deterministic fail-closed forward migration with database-enforced identity and state guards", () => {
    expect(existsSync(migrationUrl)).toBe(true);
    if (!existsSync(migrationUrl)) return;
    const migration = readFileSync(migrationUrl, "utf8");

    expect(existsSync(enumMigrationUrl)).toBe(true);
    const enumMigration = existsSync(enumMigrationUrl) ? readFileSync(enumMigrationUrl, "utf8") : "";
    expect(enumMigration).toContain('ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS \'activity.create\';');
    expect(enumMigration).toContain('ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS \'household.accent.update\';');
    expect(migration).not.toContain('ALTER TYPE "BrowserOperationKey" ADD VALUE');
    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("COMMIT;");
    expect(migration).toContain('LOCK TABLE\n  "BrowserOperationBinding",\n  "BrowserMutationOperation"\nIN SHARE ROW EXCLUSIVE MODE;');
    expect(migration.indexOf('LOCK TABLE')).toBeLessThan(migration.indexOf("browser_operation_foundation_preflight_failed:"));
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
