import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schemaPath = fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url));
const enumMigrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260824120000_api_key_containment_browser_operation/migration.sql", import.meta.url));
const constraintMigrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260824120100_api_key_containment_target_shape/migration.sql", import.meta.url));

function enumBlock(schema: string, name: string) {
  const match = schema.match(new RegExp(`enum ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`missing_enum:${name}`);
  return match[1];
}

describe("API-key containment browser-operation migration", () => {
  it("adds only the API-key revoke operation and target variants with a target-shape guard", () => {
    const schema = readFileSync(schemaPath, "utf8");
    const enumMigration = readFileSync(enumMigrationPath, "utf8");
    const migration = readFileSync(constraintMigrationPath, "utf8");

    expect(enumBlock(schema, "BrowserOperationKey")).toContain('apiKeyRevoke               @map("api_key.revoke")');
    expect(enumBlock(schema, "BrowserOperationTargetKind")).toContain("apiKey");
    expect(enumMigration).toContain("ALTER TYPE \"BrowserOperationKey\" ADD VALUE IF NOT EXISTS 'api_key.revoke'");
    expect(enumMigration).toContain("ALTER TYPE \"BrowserOperationTargetKind\" ADD VALUE IF NOT EXISTS 'api_key'");
    expect(migration).toContain("WHEN 'api_key.revoke' THEN");
    expect(migration).toContain("\"targetKind\" = 'api_key'");
    expect(migration).toContain("\"targetId\" IS NOT NULL");
    expect(migration).toContain("\"babyId\" IS NULL");
  });
});
