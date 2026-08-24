import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../../../prisma/migrations/20260821200000_audit_foundation/migration.sql", import.meta.url);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);

function modelBlock(schema: string, name: string) {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`missing_model:${name}`);
  return match[1];
}

describe("audit foundation migration", () => {
  it("adds versioned attribution and immutable database guards for both audit stores", () => {
    const migration = readFileSync(migrationUrl, "utf8");
    const schema = readFileSync(schemaUrl, "utf8");

    expect(modelBlock(schema, "AuditEvent")).toContain("schemaVersion");
    expect(modelBlock(schema, "AuditEvent")).toContain("actorUserSnapshot");
    expect(modelBlock(schema, "AuditEvent")).toContain("previousHash");
    expect(modelBlock(schema, "AuditEvent")).toContain("eventHash");
    expect(modelBlock(schema, "PlatformAuditEvent")).toContain("schemaVersion");
    expect(modelBlock(schema, "PlatformAuditEvent")).toContain("previousHash");
    expect(modelBlock(schema, "PlatformAuditEvent")).toContain("eventHash");
    expect(migration).toContain('CREATE FUNCTION "prevent_audit_event_mutation"()');
    expect(migration).toContain('CREATE TRIGGER "AuditEvent_append_only"');
    expect(migration).toContain('CREATE TRIGGER "PlatformAuditEvent_append_only"');
    expect(migration).toContain('BEFORE TRUNCATE ON "AuditEvent"');
    expect(migration).toContain('BEFORE TRUNCATE ON "PlatformAuditEvent"');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "AuditEvent"');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "PlatformAuditEvent"');
    expect(migration).toContain('CREATE FUNCTION "prevent_platform_audit_event_mutation"()');
    expect(migration).toContain('ADD COLUMN "previousHash" TEXT');
    expect(migration).toContain('ADD COLUMN "eventHash" TEXT');
    expect(migration).not.toMatch(/TG_TABLE_NAME = 'PlatformAuditEvent'[\s\S]*OLD\."householdId"/);
  });

  it("backfills every pre-existing v1 chain before append-only triggers make the rows immutable", () => {
    const migration = readFileSync(migrationUrl, "utf8");

    expect(migration).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    expect(migration).toContain('CREATE FUNCTION "canonical_audit_json"');
    expect(migration).toContain('UPDATE "AuditEvent"');
    expect(migration).toContain('UPDATE "PlatformAuditEvent"');
    expect(migration).toContain('INSERT INTO "AuditIntegrityCheckpoint"');
    expect(migration.indexOf('UPDATE "AuditEvent"')).toBeLessThan(migration.indexOf('CREATE TRIGGER "AuditEvent_append_only"'));
  });

  it("retains only a content-free receipt when permanent household deletion purges its audit trail", () => {
    const migration = readFileSync(migrationUrl, "utf8");
    const schema = readFileSync(schemaUrl, "utf8");

    expect(modelBlock(schema, "HouseholdDeletionRegistry")).toContain("householdReferenceDigest");
    expect(modelBlock(schema, "HouseholdDeletionRegistry")).toContain("auditEventCount");
    expect(migration).toContain('CREATE TABLE "HouseholdDeletionRegistry"');
    expect(migration).toContain('CREATE FUNCTION "register_household_audit_purge"()');
    expect(migration).toContain('INSERT INTO "HouseholdDeletionRegistry"');
    expect(migration).toContain('md5(OLD.id)');
    expect(migration).toContain('BEFORE DELETE ON "Household"');
    expect(migration).toContain("pg_trigger_depth() > 1");
    expect(migration).not.toContain("cubby.audit_household_purge");
    expect(migration).not.toContain('"householdName"');
  });
});
