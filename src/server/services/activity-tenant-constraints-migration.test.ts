import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260727204500_activity_household_relationship_constraints";
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

describe("activity household relationship migration", () => {
  it("adds only additive candidate keys and household-composite activity constraints", () => {
    expect(existsSync(migrationUrl)).toBe(true);

    const migration = readFileSync(migrationUrl, "utf8");
    const schema = readFileSync(schemaUrl, "utf8");

    expect(modelBlock(schema, "Baby")).toContain("@@unique([householdId, id])");
    expect(modelBlock(schema, "HouseholdMember")).toContain("@@unique([householdId, id])");
    expect(migration).toMatch(/ALTER TABLE "Baby"[\s\S]*?ADD CONSTRAINT "Baby_householdId_id_key" UNIQUE \("householdId", "id"\)/);
    expect(migration).toMatch(/ALTER TABLE "HouseholdMember"[\s\S]*?ADD CONSTRAINT "HouseholdMember_householdId_id_key" UNIQUE \("householdId", "id"\)/);

    expect(migration).toMatch(/CONSTRAINT "ActivityLog_householdId_babyId_fkey"[\s\S]*?FOREIGN KEY \("householdId", "babyId"\)[\s\S]*?REFERENCES "Baby" \("householdId", "id"\)[\s\S]*?ON DELETE CASCADE ON UPDATE CASCADE NOT VALID/);
    expect(migration).toMatch(/CONSTRAINT "ActivityLog_householdId_actorMemberId_fkey"[\s\S]*?FOREIGN KEY \("householdId", "actorMemberId"\)[\s\S]*?REFERENCES "HouseholdMember" \("householdId", "id"\)[\s\S]*?ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID/);
    expect(migration).toMatch(/CONSTRAINT "ActivityLog_householdId_deletedByMemberId_fkey"[\s\S]*?FOREIGN KEY \("householdId", "deletedByMemberId"\)[\s\S]*?REFERENCES "HouseholdMember" \("householdId", "id"\)[\s\S]*?ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID/);
    expect(migration).toContain('VALIDATE CONSTRAINT "ActivityLog_householdId_babyId_fkey"');
    expect(migration).toContain('VALIDATE CONSTRAINT "ActivityLog_householdId_actorMemberId_fkey"');
    expect(migration).toContain('VALIDATE CONSTRAINT "ActivityLog_householdId_deletedByMemberId_fkey"');
    const split = splitMigration(migration);
    expect(split).not.toBeNull();
    if (!split) return;

    expect(split.begin).toBe("BEGIN;");
    expect(split.commit).toBe("COMMIT;");
    expect(split.ddlStatements.map(compact)).toEqual([
      'ALTER TABLE "Baby" ADD CONSTRAINT "Baby_householdId_id_key" UNIQUE ("householdId", "id");',
      'ALTER TABLE "HouseholdMember" ADD CONSTRAINT "HouseholdMember_householdId_id_key" UNIQUE ("householdId", "id");',
      'ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_householdId_babyId_fkey" FOREIGN KEY ("householdId", "babyId") REFERENCES "Baby" ("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;',
      'ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_householdId_actorMemberId_fkey" FOREIGN KEY ("householdId", "actorMemberId") REFERENCES "HouseholdMember" ("householdId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;',
      'ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_householdId_deletedByMemberId_fkey" FOREIGN KEY ("householdId", "deletedByMemberId") REFERENCES "HouseholdMember" ("householdId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;',
      'ALTER TABLE "ActivityLog" VALIDATE CONSTRAINT "ActivityLog_householdId_babyId_fkey";',
      'ALTER TABLE "ActivityLog" VALIDATE CONSTRAINT "ActivityLog_householdId_actorMemberId_fkey";',
      'ALTER TABLE "ActivityLog" VALIDATE CONSTRAINT "ActivityLog_householdId_deletedByMemberId_fkey";'
    ]);
  });

  it("fails closed on a pre-existing mismatch without repairing data", () => {
    const migration = readFileSync(migrationUrl, "utf8");
    const split = splitMigration(migration);
    expect(split).not.toBeNull();
    if (!split) return;
    const { preflight } = split;

    expect(preflight).toMatch(/^DO \$\$\s+BEGIN/);
    expect((preflight.match(/\bIF EXISTS \(/g) ?? [])).toHaveLength(3);
    expect((preflight.match(/\bRAISE EXCEPTION\b/g) ?? [])).toHaveLength(3);
    expect(preflight).toMatch(/FROM "ActivityLog" AS activity\s+LEFT JOIN "Baby" AS baby ON baby\."id" = activity\."babyId"\s+WHERE baby\."id" IS NULL\s+OR activity\."householdId" <> baby\."householdId"\s+\) THEN\s+RAISE EXCEPTION 'tenant_relationship_preflight_failed:activity_baby'/);
    expect(preflight).toMatch(/FROM "ActivityLog" AS activity\s+LEFT JOIN "HouseholdMember" AS member ON member\."id" = activity\."actorMemberId"\s+WHERE member\."id" IS NULL\s+OR activity\."householdId" <> member\."householdId"\s+\) THEN\s+RAISE EXCEPTION 'tenant_relationship_preflight_failed:activity_actor_member'/);
    expect(preflight).toMatch(/FROM "ActivityLog" AS activity\s+LEFT JOIN "HouseholdMember" AS member ON member\."id" = activity\."deletedByMemberId"\s+WHERE activity\."deletedByMemberId" IS NOT NULL\s+AND \(member\."id" IS NULL OR activity\."householdId" <> member\."householdId"\)\s+\) THEN\s+RAISE EXCEPTION 'tenant_relationship_preflight_failed:activity_deleted_by_member'/);
    expect(preflight).not.toMatch(/\b(?:ALTER|CREATE|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/i);
  });
});
