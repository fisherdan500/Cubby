import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260812160000_browser_operation_r3_protocol";
const migrationUrl = new URL(`../../../prisma/migrations/${migrationDirectory}/migration.sql`, import.meta.url);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);

function modelBlock(schema: string, model: string) {
  return schema
    .split(/\r?\n(?=model\s)/)
    .find((block) => block.startsWith(`model ${model} `)) ?? "";
}

describe("browser operation R3 protocol migration contract", () => {
  it("adds versioned new-protocol markers without rewriting legacy binding or operation rows", () => {
    expect(existsSync(migrationUrl)).toBe(true);
    if (!existsSync(migrationUrl)) return;

    const migration = readFileSync(migrationUrl, "utf8");
    const schema = readFileSync(schemaUrl, "utf8");
    const binding = modelBlock(schema, "BrowserOperationBinding");

    expect(schema).toContain("enum BrowserOperationProtocolVersion");
    expect(schema).toContain("browserV1 @map(\"browser_v1\")");
    expect(schema).toContain("browserV2 @map(\"browser_v2\")");
    expect(schema).toMatch(/babyDeactivate\s+@map\("baby\.deactivate"\)/);
    expect(schema).toMatch(/babyReactivate\s+@map\("baby\.reactivate"\)/);
    expect(binding).toMatch(/protocolVersion\s+BrowserOperationProtocolVersion\s+@default\(browserV1\)/);
    expect(binding).toMatch(/targetSnapshot\s+Json\?/);

    expect(migration).toContain("BEGIN;");
    expect(migration).toContain("COMMIT;");
    expect(migration).toContain('ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS \'baby.deactivate\'');
    expect(migration).toContain('ALTER TYPE "BrowserOperationKey" ADD VALUE IF NOT EXISTS \'baby.reactivate\'');
    expect(migration).toContain('CREATE TYPE "BrowserOperationProtocolVersion" AS ENUM (\'browser_v1\', \'browser_v2\')');
    expect(migration).toContain('ADD COLUMN "protocolVersion" "BrowserOperationProtocolVersion" NOT NULL DEFAULT \'browser_v1\'');
    expect(migration).toContain('ADD COLUMN "targetSnapshot" JSONB');
    expect(migration.replace(/^--\s*/gm, "").replace(/\s+/g, " ")).toContain(
      "Existing rows remain browser_v1 and are never rewritten, retargeted, or executed by browser_v2 submit"
    );
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|INSERT\s+INTO|TRUNCATE|DROP)\b/i);
  });
});
