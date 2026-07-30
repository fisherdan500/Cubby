import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260730083000_capability_membership_ownership";
const migrationUrl = new URL(`../../../prisma/migrations/${migrationDirectory}/migration.sql`, import.meta.url);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);

function modelBlock(schema: string, model: string) {
  const match = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`missing model ${model}`);
  return match[1];
}

describe("capability membership ownership migration contract", () => {
  it("requires every episode-owned capability to reference a membership episode in the same household", () => {
    expect(existsSync(migrationUrl)).toBe(true);

    const migration = readFileSync(migrationUrl, "utf8");
    const schema = readFileSync(schemaUrl, "utf8");
    const apiKey = modelBlock(schema, "ApiKey");
    const webhookEndpoint = modelBlock(schema, "WebhookEndpoint");

    expect(modelBlock(schema, "HouseholdMember")).toContain("@@unique([householdId, id])");
    expect(apiKey).toContain('fields: [householdId, delegatedByMemberId], references: [householdId, id]');
    expect(webhookEndpoint).toContain('fields: [householdId, delegatedByMemberId], references: [householdId, id]');
    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("COMMIT;");
    expect(migration).toMatch(/FROM "ApiKey" AS capability[\s\S]+capability\."householdId" <> member\."householdId"/);
    expect(migration).toMatch(/FROM "WebhookEndpoint" AS capability[\s\S]+capability\."householdId" <> member\."householdId"/);
    expect(migration).toMatch(/LEFT JOIN "HouseholdMember" AS member/);
    expect(migration).toMatch(/member\."id" IS NULL/);
    expect(migration).toContain('FOREIGN KEY ("householdId", "delegatedByMemberId")');
    expect(migration).toContain('REFERENCES "HouseholdMember" ("householdId", "id")');
    expect(migration).toContain('CHECK (("legacyUnattributed" AND "delegatedByMemberId" IS NULL) OR (NOT "legacyUnattributed" AND "delegatedByMemberId" IS NOT NULL))');
    expect(migration).not.toContain("ON UPDATE CASCADE");
    expect(migration).toMatch(/ADD CONSTRAINT "ApiKey_householdId_delegatedByMemberId_fkey"[\s\S]+NOT VALID/);
    expect(migration).toMatch(/ADD CONSTRAINT "WebhookEndpoint_householdId_delegatedByMemberId_fkey"[\s\S]+NOT VALID/);
    expect(migration.indexOf('VALIDATE CONSTRAINT "ApiKey_householdId_delegatedByMemberId_fkey"')).toBeGreaterThan(
      migration.indexOf('ADD CONSTRAINT "ApiKey_householdId_delegatedByMemberId_fkey"')
    );
    expect(migration.indexOf('VALIDATE CONSTRAINT "WebhookEndpoint_householdId_delegatedByMemberId_fkey"')).toBeGreaterThan(
      migration.indexOf('ADD CONSTRAINT "WebhookEndpoint_householdId_delegatedByMemberId_fkey"')
    );
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE)\s+(?:FROM\s+)?"(?:ApiKey|WebhookEndpoint)"/i);
  });

  it("makes capability ownership classification write-once without adopting legacy rows", () => {
    const migration = readFileSync(migrationUrl, "utf8");

    expect(migration).toContain('CREATE FUNCTION "prevent_capability_ownership_mutation"()');
    expect(migration).toContain('OLD."householdId" IS DISTINCT FROM NEW."householdId"');
    expect(migration).toContain('OLD."delegatedByMemberId" IS DISTINCT FROM NEW."delegatedByMemberId"');
    expect(migration).toContain('OLD."legacyUnattributed" IS DISTINCT FROM NEW."legacyUnattributed"');
    expect(migration).toContain('CREATE TRIGGER "ApiKey_capability_ownership_immutable"');
    expect(migration).toContain('CREATE TRIGGER "WebhookEndpoint_capability_ownership_immutable"');
    expect(migration).toContain('BEFORE UPDATE ON "ApiKey"');
    expect(migration).toContain('BEFORE UPDATE ON "WebhookEndpoint"');
  });
});
