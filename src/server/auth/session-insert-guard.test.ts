import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../prisma/migrations/20260714191000_reversible_member_suspension/migration.sql", import.meta.url),
  "utf8"
);

describe("reversible member suspension migration", () => {
  it("serializes session insertion with membership suspension", () => {
    expect(migration).toContain('CREATE TRIGGER "Session_require_active_membership"');
    expect(migration).toContain('BEFORE INSERT ON "Session"');
    expect(migration).toContain('ORDER BY member."id"');
    expect(migration).toContain("FOR SHARE OF member");
    expect(migration).toContain('member."disabledAt" IS NULL');
    expect(migration).toContain('member."disabledAt" IS NOT NULL');
    expect(migration).toContain("Your account is disabled.");
    expect(migration).toContain("ERRCODE = 'CUB01'");
  });
});
