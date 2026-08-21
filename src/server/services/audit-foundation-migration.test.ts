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
    expect(modelBlock(schema, "PlatformAuditEvent")).toContain("schemaVersion");
    expect(migration).toContain('CREATE FUNCTION "prevent_audit_event_mutation"()');
    expect(migration).toContain('CREATE TRIGGER "AuditEvent_append_only"');
    expect(migration).toContain('CREATE TRIGGER "PlatformAuditEvent_append_only"');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "AuditEvent"');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "PlatformAuditEvent"');
  });
});
