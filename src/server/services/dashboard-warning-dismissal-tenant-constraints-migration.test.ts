import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260727222500_dashboard_warning_dismissal_household_relationship_constraints";
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

describe("dashboard warning dismissal household relationship migration", () => {
  it("adds only household-composite dismissal constraints after the parent candidate keys", () => {
    const migration = targetMigration();
    expect(migration).not.toBeNull();
    if (!migration) return;

    const schema = readFileSync(schemaUrl, "utf8");
    expect(modelBlock(schema, "Baby")).toContain("@@unique([householdId, id])");
    expect(modelBlock(schema, "HouseholdMember")).toContain("@@unique([householdId, id])");

    expect(migration).toMatch(/CONSTRAINT "DashboardWarningDismissal_householdId_babyId_fkey"[\s\S]*?FOREIGN KEY \("householdId", "babyId"\)[\s\S]*?REFERENCES "Baby" \("householdId", "id"\)[\s\S]*?ON DELETE CASCADE ON UPDATE CASCADE NOT VALID/);
    expect(migration).toMatch(/CONSTRAINT "DashboardWarningDismissal_householdId_dismissedByMemberId_fkey"[\s\S]*?FOREIGN KEY \("householdId", "dismissedByMemberId"\)[\s\S]*?REFERENCES "HouseholdMember" \("householdId", "id"\)[\s\S]*?ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID/);
    expect(migration).toContain('VALIDATE CONSTRAINT "DashboardWarningDismissal_householdId_babyId_fkey"');
    expect(migration).toContain('VALIDATE CONSTRAINT "DashboardWarningDismissal_householdId_dismissedByMemberId_fkey"');

    const split = splitMigration(migration);
    expect(split).not.toBeNull();
    if (!split) return;

    expect(split.begin).toBe("BEGIN;");
    expect(split.commit).toBe("COMMIT;");
    expect(split.ddlStatements.map(compact)).toEqual([
      'ALTER TABLE "DashboardWarningDismissal" ADD CONSTRAINT "DashboardWarningDismissal_householdId_babyId_fkey" FOREIGN KEY ("householdId", "babyId") REFERENCES "Baby" ("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;',
      'ALTER TABLE "DashboardWarningDismissal" ADD CONSTRAINT "DashboardWarningDismissal_householdId_dismissedByMemberId_fkey" FOREIGN KEY ("householdId", "dismissedByMemberId") REFERENCES "HouseholdMember" ("householdId", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;',
      'ALTER TABLE "DashboardWarningDismissal" VALIDATE CONSTRAINT "DashboardWarningDismissal_householdId_babyId_fkey";',
      'ALTER TABLE "DashboardWarningDismissal" VALIDATE CONSTRAINT "DashboardWarningDismissal_householdId_dismissedByMemberId_fkey";'
    ]);
  });

  it("fails closed on a pre-existing dismissal mismatch without repairing data", () => {
    const migration = targetMigration();
    expect(migration).not.toBeNull();
    if (!migration) return;

    const split = splitMigration(migration);
    expect(split).not.toBeNull();
    if (!split) return;

    const { preflight } = split;
    expect(preflight).toMatch(/^DO \$\$\s+BEGIN/);
    expect((preflight.match(/\bIF EXISTS \(/g) ?? [])).toHaveLength(2);
    expect((preflight.match(/\bRAISE EXCEPTION\b/g) ?? [])).toHaveLength(2);
    expect(preflight).toMatch(/FROM "DashboardWarningDismissal" AS dismissal\s+LEFT JOIN "Baby" AS baby ON baby\."id" = dismissal\."babyId"\s+WHERE baby\."id" IS NULL\s+OR dismissal\."householdId" <> baby\."householdId"\s+\) THEN\s+RAISE EXCEPTION 'tenant_relationship_preflight_failed:dashboard_warning_dismissal_baby'/);
    expect(preflight).toMatch(/FROM "DashboardWarningDismissal" AS dismissal\s+LEFT JOIN "HouseholdMember" AS member ON member\."id" = dismissal\."dismissedByMemberId"\s+WHERE member\."id" IS NULL\s+OR dismissal\."householdId" <> member\."householdId"\s+\) THEN\s+RAISE EXCEPTION 'tenant_relationship_preflight_failed:dashboard_warning_dismissal_member'/);
    expect(preflight).not.toMatch(/\b(?:ALTER|CREATE|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/i);
  });
});
