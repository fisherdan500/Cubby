import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260922194500_calendar_event_tenant_constraints";
const migrationUrl = new URL(`../../../prisma/migrations/${migrationDirectory}/migration.sql`, import.meta.url);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);
const rehearsalUrl = new URL("../../../scripts/integrity-suite.acceptance-rehearsal.ts", import.meta.url);

function modelBlock(schema: string, model: string) {
  return schema
    .split(/\r?\n(?=model\s)/)
    .find((block) => block.startsWith(`model ${model} `)) ?? "";
}

function targetMigration() {
  return existsSync(migrationUrl) ? readFileSync(migrationUrl, "utf8") : null;
}

function compact(statement: string) {
  return statement.replace(/\s+/g, " ").trim();
}

function splitMigration(migration: string) {
  const uncommented = migration.replace(/^--.*$/gm, "").trim();
  const match = uncommented.match(/^(BEGIN;)\s*(DO \$\$[\s\S]*?END \$\$;)\s*([\s\S]*?)\s*(COMMIT;)$/);
  if (!match) return null;
  return {
    begin: match[1],
    preflight: match[2],
    statements: match[3].trim().split(/;\s*/).filter(Boolean).map((statement) => `${compact(statement)};`),
    commit: match[4]
  };
}

describe("calendar event tenant relationship migration", () => {
  it("adds household-composite event, baby, and contact relations", () => {
    const migration = targetMigration();
    expect(migration).not.toBeNull();
    if (!migration) return;

    const schema = readFileSync(schemaUrl, "utf8");
    expect(modelBlock(schema, "CalendarEvent")).toContain("@@unique([householdId, id])");
    expect(modelBlock(schema, "Contact")).toContain("@@unique([householdId, id])");

    const babyLink = modelBlock(schema, "CalendarEventBaby");
    expect(babyLink).toContain("householdId String");
    expect(babyLink).toContain("@relation(fields: [householdId, babyId], references: [householdId, id], onDelete: Cascade)");
    expect(babyLink).toContain("@relation(fields: [householdId, eventId], references: [householdId, id], onDelete: Cascade)");

    const contactLink = modelBlock(schema, "CalendarEventContact");
    expect(contactLink).toContain("householdId String");
    expect(contactLink).toContain("@relation(fields: [householdId, contactId], references: [householdId, id], onDelete: Cascade)");
    expect(contactLink).toContain("@relation(fields: [householdId, eventId], references: [householdId, id], onDelete: Cascade)");

    const split = splitMigration(migration);
    expect(split).not.toBeNull();
    if (!split) return;
    expect(split.begin).toBe("BEGIN;");
    expect(split.commit).toBe("COMMIT;");
    expect(split.statements).toEqual([
      'ALTER TABLE "CalendarEventBaby" ADD COLUMN "householdId" TEXT;',
      'ALTER TABLE "CalendarEventContact" ADD COLUMN "householdId" TEXT;',
      'UPDATE "CalendarEventBaby" AS link SET "householdId" = event."householdId" FROM "CalendarEvent" AS event WHERE event."id" = link."eventId";',
      'UPDATE "CalendarEventContact" AS link SET "householdId" = event."householdId" FROM "CalendarEvent" AS event WHERE event."id" = link."eventId";',
      'ALTER TABLE "CalendarEventBaby" ALTER COLUMN "householdId" SET NOT NULL;',
      'ALTER TABLE "CalendarEventContact" ALTER COLUMN "householdId" SET NOT NULL;',
      'ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_householdId_id_key" UNIQUE ("householdId", "id");',
      'ALTER TABLE "Contact" ADD CONSTRAINT "Contact_householdId_id_key" UNIQUE ("householdId", "id");',
      'CREATE INDEX "CalendarEventBaby_householdId_idx" ON "CalendarEventBaby"("householdId");',
      'CREATE INDEX "CalendarEventContact_householdId_idx" ON "CalendarEventContact"("householdId");',
      'ALTER TABLE "CalendarEventBaby" DROP CONSTRAINT "CalendarEventBaby_babyId_fkey";',
      'ALTER TABLE "CalendarEventBaby" DROP CONSTRAINT "CalendarEventBaby_eventId_fkey";',
      'ALTER TABLE "CalendarEventContact" DROP CONSTRAINT "CalendarEventContact_contactId_fkey";',
      'ALTER TABLE "CalendarEventContact" DROP CONSTRAINT "CalendarEventContact_eventId_fkey";',
      'ALTER TABLE "CalendarEventBaby" ADD CONSTRAINT "CalendarEventBaby_householdId_babyId_fkey" FOREIGN KEY ("householdId", "babyId") REFERENCES "Baby" ("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;',
      'ALTER TABLE "CalendarEventBaby" ADD CONSTRAINT "CalendarEventBaby_householdId_eventId_fkey" FOREIGN KEY ("householdId", "eventId") REFERENCES "CalendarEvent" ("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;',
      'ALTER TABLE "CalendarEventContact" ADD CONSTRAINT "CalendarEventContact_householdId_contactId_fkey" FOREIGN KEY ("householdId", "contactId") REFERENCES "Contact" ("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;',
      'ALTER TABLE "CalendarEventContact" ADD CONSTRAINT "CalendarEventContact_householdId_eventId_fkey" FOREIGN KEY ("householdId", "eventId") REFERENCES "CalendarEvent" ("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;',
      'ALTER TABLE "CalendarEventBaby" VALIDATE CONSTRAINT "CalendarEventBaby_householdId_babyId_fkey";',
      'ALTER TABLE "CalendarEventBaby" VALIDATE CONSTRAINT "CalendarEventBaby_householdId_eventId_fkey";',
      'ALTER TABLE "CalendarEventContact" VALIDATE CONSTRAINT "CalendarEventContact_householdId_contactId_fkey";',
      'ALTER TABLE "CalendarEventContact" VALIDATE CONSTRAINT "CalendarEventContact_householdId_eventId_fkey";'
    ]);
  });

  it("fails closed on existing cross-household links before adding or backfilling household keys", () => {
    const migration = targetMigration();
    expect(migration).not.toBeNull();
    if (!migration) return;

    const split = splitMigration(migration);
    expect(split).not.toBeNull();
    if (!split) return;
    const { preflight } = split;
    expect(preflight).toMatch(/FROM "CalendarEventBaby" AS link[\s\S]*LEFT JOIN "CalendarEvent" AS event[\s\S]*LEFT JOIN "Baby" AS baby[\s\S]*event\."householdId" <> baby\."householdId"[\s\S]*tenant_relationship_preflight_failed:calendar_event_baby/);
    expect(preflight).toMatch(/FROM "CalendarEventContact" AS link[\s\S]*LEFT JOIN "CalendarEvent" AS event[\s\S]*LEFT JOIN "Contact" AS contact[\s\S]*event\."householdId" <> contact\."householdId"[\s\S]*tenant_relationship_preflight_failed:calendar_event_contact/);
    expect(preflight).toMatch(/event\."id" IS NULL\s+OR baby\."id" IS NULL/);
    expect(preflight).toMatch(/event\."id" IS NULL\s+OR contact\."id" IS NULL/);
    expect(preflight).not.toMatch(/\b(?:ALTER|CREATE|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/i);

    expect(split.statements.filter((statement) => statement.startsWith("UPDATE ")).map((statement) => statement.match(/^UPDATE\s+"[^"]+"/)?.[0])).toEqual([
      'UPDATE "CalendarEventBaby"',
      'UPDATE "CalendarEventContact"'
    ]);
    expect(migration).not.toMatch(/\b(?:INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\b/i);
    expect(migration.indexOf('UPDATE "CalendarEventBaby"')).toBeLessThan(migration.indexOf('ALTER COLUMN "householdId" SET NOT NULL'));
  });

  it("wires executable mismatch and orphan rollback cases before the clean target migration", () => {
    const rehearsal = readFileSync(rehearsalUrl, "utf8");

    expect(rehearsal).toContain(`const targetMigration = "${migrationDirectory}"`);
    expect(rehearsal).toContain("holdMigrationsFrom");
    expect(rehearsal).toContain("restoreHeldMigration(targetMigration");
    for (const scenario of ["baby_tenant_mismatch", "contact_tenant_mismatch", "baby_orphan", "contact_orphan"]) {
      expect(rehearsal).toContain(`"${scenario}"`);
    }
    expect(rehearsal).toContain("tenant_relationship_preflight_failed:calendar_event_baby");
    expect(rehearsal).toContain("tenant_relationship_preflight_failed:calendar_event_contact");
    expect(rehearsal).toContain('"migrate", "resolve", "--rolled-back", targetMigration');
    expect(rehearsal).toContain("calendar_event_tenant_rollback_incomplete");
    expect(rehearsal).toContain("runTargetMigrationRollbackCases(compose, env, databaseUrl, prismaCli, targetMigrationPath)");
  });
});
