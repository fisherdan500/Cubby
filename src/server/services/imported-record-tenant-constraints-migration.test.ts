import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260728160000_imported_record_household_relationship_constraints";
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

describe("imported record household relationship migration", () => {
  it("adds only the import batch candidate key and imported record composite constraint in ordered transaction scope", () => {
    const migration = targetMigration();
    expect(migration).not.toBeNull();
    if (!migration) return;

    const schema = readFileSync(schemaUrl, "utf8");
    expect(modelBlock(schema, "ImportBatch")).toContain("@@unique([householdId, id])");
    expect(migration).toMatch(/CONSTRAINT "ImportedRecord_householdId_importBatchId_fkey"[\s\S]*?FOREIGN KEY \("householdId", "importBatchId"\)[\s\S]*?REFERENCES "ImportBatch" \("householdId", "id"\)[\s\S]*?ON DELETE CASCADE ON UPDATE CASCADE NOT VALID/);
    expect(migration).toContain('VALIDATE CONSTRAINT "ImportedRecord_householdId_importBatchId_fkey"');
    expect(migration).not.toContain('"targetType"');
    expect(migration).not.toContain('"targetId"');

    const split = splitMigration(migration);
    expect(split).not.toBeNull();
    if (!split) return;

    expect(split.begin).toBe("BEGIN;");
    expect(split.commit).toBe("COMMIT;");
    expect(split.ddlStatements.map(compact)).toEqual([
      'ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_householdId_id_key" UNIQUE ("householdId", "id");',
      'ALTER TABLE "ImportedRecord" ADD CONSTRAINT "ImportedRecord_householdId_importBatchId_fkey" FOREIGN KEY ("householdId", "importBatchId") REFERENCES "ImportBatch" ("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;',
      'ALTER TABLE "ImportedRecord" VALIDATE CONSTRAINT "ImportedRecord_householdId_importBatchId_fkey";'
    ]);
  });

  it("fails closed on a pre-existing ImportedRecord import batch mismatch without repairing data", () => {
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
    expect(preflight).toMatch(/FROM "ImportedRecord" AS record\s+LEFT JOIN "ImportBatch" AS batch ON batch\."id" = record\."importBatchId"\s+WHERE batch\."id" IS NULL\s+OR record\."householdId" <> batch\."householdId"\s+\) THEN\s+RAISE EXCEPTION 'tenant_relationship_preflight_failed:imported_record_import_batch'/);
    expect(preflight).not.toMatch(/\b(?:ALTER|CREATE|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/i);
  });
});
