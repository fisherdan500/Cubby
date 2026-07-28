import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260728112256_notification_preference_household_relationship_constraints";
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

describe("notification preference household relationship migration", () => {
  it("adds only the nullable household-composite notification preference constraint using the existing Baby candidate key", () => {
    const migration = targetMigration();
    expect(migration).not.toBeNull();
    if (!migration) return;

    const schema = readFileSync(schemaUrl, "utf8");
    expect(modelBlock(schema, "Baby")).toContain("@@unique([householdId, id])");
    expect(migration).not.toContain('ADD CONSTRAINT "Baby_householdId_id_key"');

    expect(migration).toMatch(/CONSTRAINT "NotificationPreference_householdId_babyId_fkey"[\s\S]*?FOREIGN KEY \("householdId", "babyId"\)[\s\S]*?REFERENCES "Baby" \("householdId", "id"\)[\s\S]*?ON DELETE CASCADE ON UPDATE CASCADE NOT VALID/);
    expect(migration).toContain('VALIDATE CONSTRAINT "NotificationPreference_householdId_babyId_fkey"');

    const split = splitMigration(migration);
    expect(split).not.toBeNull();
    if (!split) return;

    expect(split.begin).toBe("BEGIN;");
    expect(split.commit).toBe("COMMIT;");
    expect(split.ddlStatements.map(compact)).toEqual([
      'ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_householdId_babyId_fkey" FOREIGN KEY ("householdId", "babyId") REFERENCES "Baby" ("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;',
      'ALTER TABLE "NotificationPreference" VALIDATE CONSTRAINT "NotificationPreference_householdId_babyId_fkey";'
    ]);
  });

  it("fails closed on a pre-existing non-null NotificationPreference Baby mismatch without repairing data", () => {
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
    expect(preflight).toMatch(/FROM "NotificationPreference" AS preference\s+LEFT JOIN "Baby" AS baby ON baby\."id" = preference\."babyId"\s+WHERE preference\."babyId" IS NOT NULL\s+AND \(baby\."id" IS NULL OR preference\."householdId" <> baby\."householdId"\)\s+\) THEN\s+RAISE EXCEPTION 'tenant_relationship_preflight_failed:notification_preference_baby'/);
    expect(preflight).not.toMatch(/\b(?:ALTER|CREATE|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/i);
  });
});
