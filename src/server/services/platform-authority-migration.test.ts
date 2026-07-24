import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../prisma/migrations/20260722130000_platform_authority_registration_policy/migration.sql",
  import.meta.url
);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);

describe("platform authority migration contract", () => {
  it("adds an explicit singleton authority and closed-default platform policy", () => {
    expect(existsSync(migrationUrl)).toBe(true);
    const migration = readFileSync(migrationUrl, "utf8");
    const schema = readFileSync(schemaUrl, "utf8");

    expect(migration).toContain('CREATE TYPE "PlatformRegistrationMode" AS ENUM (\'closed\', \'invitation_only\', \'open\')');
    expect(migration).toContain('CREATE TABLE "PlatformAuthority"');
    expect(migration).toContain('CREATE TABLE "PlatformSettings"');
    expect(migration).toContain('CREATE TABLE "PlatformAuditEvent"');
    expect(migration).toContain('"householdCreationMode" "PlatformRegistrationMode" NOT NULL DEFAULT \'closed\'');
    expect(migration).toContain('"allowPublicRegistration" BOOLEAN NOT NULL DEFAULT false');
    expect(migration).toMatch(/CHECK \("id" = 'platform'\)/);
    expect(schema).toContain("model PlatformAuthority");
    expect(schema).toContain("model PlatformSettings");
  });

  it("never selects or inserts an owner and preserves legacy household policy columns", () => {
    expect(existsSync(migrationUrl)).toBe(true);
    const migration = readFileSync(migrationUrl, "utf8");
    const schema = readFileSync(schemaUrl, "utf8");

    expect(migration).not.toMatch(/INSERT\s+INTO\s+"PlatformAuthority"/i);
    expect(migration).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+"PlatformAuthority"/i);
    expect(migration).not.toMatch(/DROP\s+COLUMN\s+"allow(?:PublicRegistration|NewHouseholdCreation)"/i);
    expect(schema).toMatch(/allowPublicRegistration\s+Boolean\s+@default\(false\)/);
    expect(schema).toMatch(/allowNewHouseholdCreation\s+Boolean\s+@default\(false\)/);
  });

  it("prevents deletion of the bound owner and preserves audit actor identifiers independently", () => {
    expect(existsSync(migrationUrl)).toBe(true);
    const migration = readFileSync(migrationUrl, "utf8");

    expect(migration).toMatch(/FOREIGN KEY \("ownerUserId"\)[\s\S]+ON DELETE RESTRICT/);
    expect(migration).toContain('"actorUserId" TEXT');
    expect(migration).not.toContain('"actorUserId" TEXT NOT NULL');
    expect(migration).not.toMatch(/FOREIGN KEY \("actorUserId"\)/);
  });

  it("keeps platform-owner authentication independent of household suspension", () => {
    const migration = readFileSync(migrationUrl, "utf8");

    expect(migration).toContain('CREATE OR REPLACE FUNCTION "require_active_membership_for_session"()');
    expect(migration).toMatch(/FROM "PlatformAuthority"[\s\S]+"ownerUserId" = NEW\."userId"/);
  });
});
