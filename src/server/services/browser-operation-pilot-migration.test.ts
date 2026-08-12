import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260811190000_browser_operation_pilot";
const migrationUrl = new URL(`../../../prisma/migrations/${migrationDirectory}/migration.sql`, import.meta.url);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);

function modelBlock(schema: string, model: string) {
  return schema
    .split(/\r?\n(?=model\s)/)
    .find((block) => block.startsWith(`model ${model} `)) ?? "";
}

describe("browser operation pilot migration contract", () => {
  it("adds only the closed pilot binding and operation persistence contract", () => {
    expect(existsSync(migrationUrl)).toBe(true);
    if (!existsSync(migrationUrl)) return;

    const migration = readFileSync(migrationUrl, "utf8");
    const schema = readFileSync(schemaUrl, "utf8");
    const binding = modelBlock(schema, "BrowserOperationBinding");
    const operation = modelBlock(schema, "BrowserMutationOperation");

    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("COMMIT;");
    expect(migration).toContain(
      'CREATE TYPE "BrowserOperationKey" AS ENUM (\'calendar_event.create\', \'dashboard.warning.dismiss\')'
    );
    expect(migration).toContain(
      'CREATE TYPE "BrowserOperationBindingState" AS ENUM (\'open\', \'submitted\', \'revoked\', \'expired\', \'terminal\')'
    );
    expect(migration).toContain(
      'CREATE TYPE "BrowserMutationOperationStatus" AS ENUM (\'pending\', \'completed\', \'rejected\', \'stale\', \'unknown\')'
    );
    expect(migration).toContain('CREATE TABLE "BrowserOperationBinding"');
    expect(migration).toContain('CREATE TABLE "BrowserMutationOperation"');

    expect(binding).toContain("sessionId         String");
    expect(binding).toContain("actorUserId       String");
    expect(binding).toContain("actorMemberId     String");
    expect(binding).toContain("householdId       String");
    expect(binding).toContain("operationId       String");
    expect(binding).toContain("operationKey      BrowserOperationKey");
    expect(binding).toContain("intentFingerprint String");
    expect(binding).toContain("babyId            String?");
    expect(binding).toContain("expiresAt         DateTime");
    expect(binding).toContain("state             BrowserOperationBindingState");
    expect(binding).toContain("@@unique([householdId, operationId])");
    expect(binding).toContain(
      "fields: [householdId, actorMemberId], references: [householdId, id]"
    );
    expect(binding).toContain("fields: [householdId, babyId], references: [householdId, id]");

    expect(operation).toContain("bindingId         String");
    expect(operation).toMatch(/bindingId\s+String\s+@unique/);
    expect(operation).toContain("householdId       String");
    expect(operation).toContain("operationId       String");
    expect(operation).toContain("operationKey      BrowserOperationKey");
    expect(operation).toContain("actorUserId       String");
    expect(operation).toContain("actorMemberId     String");
    expect(operation).toContain("intentFingerprint String");
    expect(operation).toContain("babyId            String?");
    expect(operation).toContain("status            BrowserMutationOperationStatus");
    expect(operation).toContain("outcomeVersion    Int?");
    expect(operation).toContain("outcomeKind       String?");
    expect(operation).toContain("outcomeCode       String?");
    expect(operation).toContain("outcomeSnapshot   Json?");
    expect(operation).toContain("terminalAt        DateTime?");
    expect(operation).toContain("@@id([householdId, operationId])");
    expect(operation).toContain(
      "fields: [householdId, actorMemberId], references: [householdId, id]"
    );
    expect(operation).toContain("fields: [householdId, babyId], references: [householdId, id]");

    expect(migration).toContain(
      'CREATE UNIQUE INDEX "BrowserOperationBinding_householdId_operationId_key" ON "BrowserOperationBinding"("householdId", "operationId")'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "BrowserMutationOperation_bindingId_key" ON "BrowserMutationOperation"("bindingId")'
    );
    expect(migration).toMatch(
      /"bindingId" TEXT NOT NULL[\s\S]*?CONSTRAINT "BrowserMutationOperation_bindingId_fkey"[\s\S]*?FOREIGN KEY \("bindingId"\)[\s\S]*?REFERENCES "BrowserOperationBinding"\("id"\) ON DELETE RESTRICT/
    );
    expect(migration).toContain('FOREIGN KEY ("householdId", "actorMemberId")');
    expect(migration).toContain('REFERENCES "HouseholdMember"("householdId", "id")');
    expect(migration).toContain('FOREIGN KEY ("householdId", "babyId")');
    expect(migration).toContain('REFERENCES "Baby"("householdId", "id")');
    expect(migration).toContain('CONSTRAINT "BrowserMutationOperation_terminal_outcome_check" CHECK');

    const preflight = migration.match(/DO \$\$[\s\S]*?\$\$;/)?.[0] ?? "";
    expect(preflight).not.toBe("");
    expect((preflight.match(/\bIF EXISTS \(/g) ?? [])).toHaveLength(11);
    expect((preflight.match(/\bRAISE EXCEPTION\b/g) ?? [])).toHaveLength(11);
    for (const relationship of [
      "binding_household",
      "binding_actor_user",
      "binding_session_actor",
      "binding_member_actor",
      "binding_baby",
      "operation_binding",
      "operation_household",
      "operation_actor_user",
      "operation_member_actor",
      "operation_baby",
      "calendar_event_baby"
    ]) {
      expect(preflight).toContain(`browser_operation_preflight_failed:${relationship}`);
    }
    expect(preflight).not.toMatch(/\b(?:ALTER|CREATE|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/i);

    expect(migration).toContain('CREATE FUNCTION "prevent_terminal_browser_mutation_operation_mutation"()');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "BrowserMutationOperation"');
    expect(migration).toMatch(/OLD\."status" IN \('completed', 'rejected', 'stale'\)/);
    expect(migration).toContain("terminal_browser_mutation_operation_immutable");

    expect(migration).toContain("source_reviewed_subset");
    expect(preflight).toMatch(/FROM "CalendarEventBaby" AS link[\s\S]*?JOIN "CalendarEvent" AS event[\s\S]*?JOIN "Baby" AS baby[\s\S]*?event\."householdId" <> baby\."householdId"/);
    const outsidePreflight = migration.replace(preflight, "").replace(/^--.*$/gm, "");
    expect(outsidePreflight).not.toContain('"CalendarEventBaby"');
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE)\b/i);
    expect(migration).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"/i);
  });
});
