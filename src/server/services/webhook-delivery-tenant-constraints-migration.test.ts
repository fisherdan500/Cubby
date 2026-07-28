import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260728141500_webhook_delivery_household_relationship_constraints";
const migrationUrl = new URL(`../../../prisma/migrations/${migrationDirectory}/migration.sql`, import.meta.url);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);

function modelBlock(schema: string, model: string) {
  return schema
    .split(/\r?\n(?=model\s)/)
    .find((block) => block.startsWith(`model ${model} `)) ?? "";
}

function compact(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

function targetMigration() {
  return existsSync(migrationUrl) ? readFileSync(migrationUrl, "utf8") : null;
}

function splitMigration(migration: string) {
  const uncommented = migration.replace(/^--.*$/gm, "").trim();
  const match = uncommented.match(/^(BEGIN;)\s*(DO \$\$[\s\S]*?\$\$;)\s*([\s\S]*?)\s*(COMMIT;)$/);
  if (!match) return null;

  return {
    begin: match[1],
    preflight: match[2],
    ddlStatements: match[3].trim().split(/;\s*/).filter(Boolean).map((statement) => `${statement};`),
    commit: match[4]
  };
}

describe("webhook delivery household relationship migration", () => {
  it("adds only the endpoint candidate key and delivery composite constraint in ordered transaction scope", () => {
    const migration = targetMigration();
    expect(migration).not.toBeNull();
    if (!migration) return;

    const schema = readFileSync(schemaUrl, "utf8");
    expect(modelBlock(schema, "WebhookEndpoint")).toContain("@@unique([householdId, id])");
    expect(migration).toMatch(/CONSTRAINT "WebhookDelivery_householdId_endpointId_fkey"[\s\S]*?FOREIGN KEY \("householdId", "endpointId"\)[\s\S]*?REFERENCES "WebhookEndpoint" \("householdId", "id"\)[\s\S]*?ON DELETE CASCADE ON UPDATE CASCADE NOT VALID/);
    expect(migration).toContain('VALIDATE CONSTRAINT "WebhookDelivery_householdId_endpointId_fkey"');
    expect(migration).not.toContain('"activityId"');

    const split = splitMigration(migration);
    expect(split).not.toBeNull();
    if (!split) return;

    expect(split.begin).toBe("BEGIN;");
    expect(split.commit).toBe("COMMIT;");
    expect(split.ddlStatements.map(compact)).toEqual([
      'ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_householdId_id_key" UNIQUE ("householdId", "id");',
      'ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_householdId_endpointId_fkey" FOREIGN KEY ("householdId", "endpointId") REFERENCES "WebhookEndpoint" ("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;',
      'ALTER TABLE "WebhookDelivery" VALIDATE CONSTRAINT "WebhookDelivery_householdId_endpointId_fkey";'
    ]);
  });

  it("fails closed on a pre-existing WebhookDelivery endpoint mismatch without repairing data", () => {
    const migration = targetMigration();
    expect(migration).not.toBeNull();
    if (!migration) return;

    const split = splitMigration(migration);
    expect(split).not.toBeNull();
    if (!split) return;

    const { preflight } = split;
    expect(preflight).toMatch(/^DO \$\$\s+BEGIN/);
    expect((preflight.match(/\bIF EXISTS \(/g) ?? [])).toHaveLength(1);
    expect((preflight.match(/\bRAISE EXCEPTION\b/g) ?? [])).toHaveLength(1);
    expect(preflight).toMatch(/FROM "WebhookDelivery" AS delivery\s+LEFT JOIN "WebhookEndpoint" AS endpoint ON endpoint\."id" = delivery\."endpointId"\s+WHERE endpoint\."id" IS NULL\s+OR delivery\."householdId" <> endpoint\."householdId"\s+\) THEN\s+RAISE EXCEPTION 'tenant_relationship_preflight_failed:webhook_delivery_endpoint'/);
    expect(preflight).not.toMatch(/\b(?:ALTER|CREATE|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/i);
  });
});
