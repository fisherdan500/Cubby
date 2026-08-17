import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260817213000_account_appearance_browser_operations";
const migrationUrl = new URL(`../../../prisma/migrations/${migrationDirectory}/migration.sql`, import.meta.url);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);

function block(source: string, kind: "model" | "enum", name: string) {
  return source
    .split(new RegExp(`\\r?\\n(?=${kind}\\s)`))
    .find((candidate) => candidate.startsWith(`${kind} ${name} `)) ?? "";
}

describe("account appearance browser-operation persistence", () => {
  it("adds a system-default monotonic User appearance preference without inferring an accent", () => {
    const schema = readFileSync(schemaUrl, "utf8");
    const appearanceMode = block(schema, "enum", "AppearanceMode");
    const user = block(schema, "model", "User");

    for (const mode of ["system", "light", "dark"]) expect(appearanceMode).toMatch(new RegExp(`\\b${mode}\\b`));
    expect(user).toMatch(/appearanceMode\s+AppearanceMode\s+@default\(system\)/);
    expect(user).toMatch(/appearanceRevision\s+Int\s+@default\(0\)/);
    expect(user).not.toMatch(/appearanceMode.*accent|accent.*appearanceMode/i);
  });

  it("uses three separate non-null account-scoped identity tables with no household half-scope", () => {
    const schema = readFileSync(schemaUrl, "utf8");
    const binding = block(schema, "model", "AccountOperationBinding");
    const operation = block(schema, "model", "AccountMutationOperation");
    const tombstone = block(schema, "model", "AccountMutationOperationTombstone");

    expect(block(schema, "enum", "AccountOperationKey")).toContain('@map("account.appearance.update")');
    expect(binding).toMatch(/userId\s+String\b/);
    expect(binding).toMatch(/sessionId\s+String\b/);
    expect(binding).toMatch(/openingFingerprint\s+String\b/);
    expect(binding).toContain("@@unique([userId, operationId])");
    expect(operation).toMatch(/bindingId\s+String\s+@unique/);
    expect(operation).toMatch(/intentFingerprint\s+String\b/);
    expect(operation).toContain("@@id([userId, operationId])");
    expect(tombstone).toContain("@@id([userId, operationId])");
    expect(tombstone).not.toMatch(/outcomeSnapshot|openingFingerprint|targetSnapshot|request|payload|error/);
    for (const model of [binding, operation, tombstone]) {
      expect(model).not.toMatch(/householdId|actorMemberId|babyId|Household|HouseholdMember|Baby/);
    }
  });

  it("adds a forward-only guarded account ledger migration without applying or rewriting household data", () => {
    expect(existsSync(migrationUrl)).toBe(true);
    if (!existsSync(migrationUrl)) return;
    const migration = readFileSync(migrationUrl, "utf8");

    expect(migration).toContain('CREATE TABLE "AccountOperationBinding"');
    expect(migration).toContain('CREATE TABLE "AccountMutationOperation"');
    expect(migration).toContain('CREATE TABLE "AccountMutationOperationTombstone"');
    expect(migration).toContain('lock_account_browser_operation_identity');
    expect(migration).toContain('guard_account_operation_binding_insert');
    expect(migration).toContain('guard_account_mutation_operation_insert');
    expect(migration).toContain('guard_account_operation_tombstone_insert');
    expect(migration).toContain('enforce_account_operation_binding_write_once');
    expect(migration).toContain('enforce_account_mutation_operation_transition');
    expect(migration).toContain('account_operation_tombstone_immutable');
    expect(migration).toContain('compact_account_browser_operation');
    expect(migration).toContain("INTERVAL '30 days'");
    expect(migration).toContain("account.appearance.update");
    expect(migration).toContain("Appearance mode defaults to system; no value is derived from HouseholdSettings.accentTheme");
    expect(migration).not.toMatch(/UPDATE\s+"User"[\s\S]*accentTheme/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
  });
});
