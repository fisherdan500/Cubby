import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../prisma/migrations/20260801140000_platform_registration_operation_status/migration.sql",
  import.meta.url
);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);

describe("platform registration operation migration contract", () => {
  it("persists server-issued operation bindings and the audit relation", () => {
    expect(existsSync(migrationUrl)).toBe(true);
    const migration = readFileSync(migrationUrl, "utf8");
    const schema = readFileSync(schemaUrl, "utf8");

    expect(migration).toContain('CREATE TYPE "PlatformRegistrationOperationStatus" AS ENUM (\'pending\', \'completed\', \'stale\')');
    expect(migration).toContain('CREATE TABLE "PlatformRegistrationOperation"');
    expect(migration).toContain('"intentFingerprint" TEXT NOT NULL');
    expect(migration).toContain('"expectedRevision" INTEGER NOT NULL');
    expect(migration).toContain('"auditEventId" TEXT');
    expect(migration).toContain('FOREIGN KEY ("auditEventId") REFERENCES "PlatformAuditEvent"("id") ON DELETE RESTRICT');
    expect(schema).toMatch(/model PlatformRegistrationOperation[\s\S]+auditEventId\s+String\?\s+@unique/);
    expect(schema).toMatch(/model PlatformRegistrationOperation[\s\S]+auditEvent\s+PlatformAuditEvent\?\s+@relation/);
  });

  it("prevents terminal operation rows from being changed or deleted", () => {
    const migration = readFileSync(migrationUrl, "utf8");

    expect(migration).toContain('CREATE FUNCTION "prevent_terminal_platform_registration_operation_mutation"()');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "PlatformRegistrationOperation"');
    expect(migration).toMatch(/OLD\."status" IN \('completed', 'stale'\)/);
    expect(migration).toContain('terminal_platform_registration_operation_immutable');
  });
});
