import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const enumMigrationDirectory = "20260930120000_baby_photo_attachment_type";
const structureMigrationDirectory = "20260930120100_baby_photo_attachment_ownership";
const enumMigrationUrl = new URL(`../../../prisma/migrations/${enumMigrationDirectory}/migration.sql`, import.meta.url);
const structureMigrationUrl = new URL(`../../../prisma/migrations/${structureMigrationDirectory}/migration.sql`, import.meta.url);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);

function modelBlock(schema: string, model: string) {
  return schema
    .split(/\r?\n(?=model\s)/)
    .find((block) => block.startsWith(`model ${model} `)) ?? "";
}

function enumBlock(schema: string, name: string) {
  return schema
    .split(/\r?\n(?=enum\s)/)
    .find((block) => block.startsWith(`enum ${name} `)) ?? "";
}

function compact(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

function statements(migration: string) {
  return migration
    .replace(/^--.*$/gm, "")
    .trim()
    .split(/;\s*/)
    .filter(Boolean)
    .map((statement) => compact(`${statement};`));
}

describe("baby photo attachment type migration", () => {
  it("adds the enum value in its own migration with no transaction and no use of the new value", () => {
    expect(existsSync(enumMigrationUrl)).toBe(true);

    const migration = readFileSync(enumMigrationUrl, "utf8");

    // PostgreSQL cannot use a new enum value in the same transaction that adds it,
    // so this migration must contain the ALTER TYPE alone and must not open a transaction.
    expect(statements(migration)).toEqual([
      'ALTER TYPE "AttachmentType" ADD VALUE IF NOT EXISTS \'baby_photo\';'
    ]);
    expect(migration).not.toMatch(/\bBEGIN;/);
    expect(migration).not.toMatch(/\bCOMMIT;/);
  });

  it("declares baby_photo on the schema enum", () => {
    const schema = readFileSync(schemaUrl, "utf8");
    const block = enumBlock(schema, "AttachmentType");

    expect(block).toContain("feed_photo");
    expect(block).toContain("baby_photo");
  });

  it("adds baby ownership, a tenant-safe composite foreign key, and one-served-photo-per-baby", () => {
    expect(existsSync(structureMigrationUrl)).toBe(true);

    const migration = readFileSync(structureMigrationUrl, "utf8");
    const schema = readFileSync(schemaUrl, "utf8");

    const attachment = modelBlock(schema, "Attachment");
    expect(attachment).toContain("babyId");
    expect(attachment).toMatch(/baby\s+Baby\?\s+@relation\(fields: \[householdId, babyId\], references: \[householdId, id\], onDelete: Cascade\)/);

    // The pre-existing @@unique([householdId, postId, position]) does NOT constrain rows whose
    // postId is NULL, so one-served-photo-per-baby needs its own partial unique index. It is
    // scoped to state 'available' because that is the state the delivery path serves, and because
    // a replaced picture stays in its recovery window and must not block its replacement.
    //
    // The ownership CHECKs keep the two shapes disjoint without forbidding staging: a staged
    // attachment has no parent at all (staging creates the row, the claim step sets the parent).
    expect(statements(migration)).toEqual([
      'BEGIN;',
      'ALTER TABLE "Attachment" ADD COLUMN "babyId" TEXT;',
      'ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_householdId_babyId_fkey" FOREIGN KEY ("householdId", "babyId") REFERENCES "Baby" ("householdId", "id") ON DELETE CASCADE ON UPDATE CASCADE;',
      'CREATE INDEX "Attachment_householdId_babyId_idx" ON "Attachment"("householdId", "babyId");',
      'CREATE UNIQUE INDEX "Attachment_one_available_baby_photo" ON "Attachment"("householdId", "babyId") WHERE "type" = \'baby_photo\' AND "state" = \'available\';',
      'ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_baby_photo_parent" CHECK (("type" = \'baby_photo\' AND "postId" IS NULL) OR ("type" <> \'baby_photo\' AND "babyId" IS NULL));',
      'ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_available_baby_photo_has_baby" CHECK (NOT ("type" = \'baby_photo\' AND "state" = \'available\' AND "babyId" IS NULL));',
      'ALTER TABLE "Attachment" DROP CONSTRAINT "Attachment_lifecycle_check";',
      'ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_lifecycle_check" CHECK (CASE "state" WHEN \'staging\' THEN "postId" IS NULL AND "position" IS NULL AND "babyId" IS NULL AND "activatedAt" IS NULL AND "deletedAt" IS NULL AND "purgeAfter" IS NULL AND "purgedAt" IS NULL WHEN \'available\' THEN "activatedAt" IS NOT NULL AND "deletedAt" IS NULL AND "purgeAfter" IS NULL AND "purgedAt" IS NULL AND CASE WHEN "type" = \'baby_photo\' THEN "babyId" IS NOT NULL AND "postId" IS NULL AND "position" IS NULL ELSE "postId" IS NOT NULL AND "position" IS NOT NULL END WHEN \'unavailable\' THEN "unavailableAt" IS NOT NULL AND "purgedAt" IS NULL WHEN \'deleted\' THEN "deletedAt" IS NOT NULL AND "purgeAfter" IS NOT NULL AND "purgedAt" IS NULL WHEN \'purged\' THEN "purgedAt" IS NOT NULL END);',
      'COMMIT;'
    ]);
  });

  it("widens the lifecycle check by ownership instead of weakening it for every type", () => {
    const migration = readFileSync(structureMigrationUrl, "utf8");
    const ddl = statements(migration).join("\n");

    // The pre-existing check hard-codes that an AVAILABLE attachment has a post AND a position.
    // A baby photo has neither, so without this widening it could never leave staging - and no
    // source gate would reveal that, because none of them parse migration SQL.
    //
    // The post requirement must survive for post-owned types. Dropping it for everyone would let
    // a feed photo go live with no post, which is the shape the delivery path relies on.
    expect(ddl).toMatch(/ELSE "postId" IS NOT NULL AND "position" IS NOT NULL END/);
    expect(ddl).toMatch(/WHEN "type" = 'baby_photo' THEN "babyId" IS NOT NULL AND "postId" IS NULL AND "position" IS NULL/);
    // A staged row still has no parent of either kind.
    expect(ddl).toMatch(/WHEN 'staging' THEN "postId" IS NULL AND "position" IS NULL AND "babyId" IS NULL/);
    // The terminal states are carried over unchanged.
    expect(ddl).toMatch(/WHEN 'unavailable' THEN "unavailableAt" IS NOT NULL AND "purgedAt" IS NULL/);
    expect(ddl).toMatch(/WHEN 'deleted' THEN "deletedAt" IS NOT NULL AND "purgeAfter" IS NOT NULL AND "purgedAt" IS NULL/);
    expect(ddl).toMatch(/WHEN 'purged' THEN "purgedAt" IS NOT NULL END/);
    // Every state stays enumerated: a CASE with no matching branch yields NULL, and a CHECK treats
    // NULL as satisfied, so a dropped branch silently stops enforcing that state.
    for (const state of ["staging", "available", "unavailable", "deleted", "purged"]) {
      expect(ddl).toContain(`WHEN '${state}' THEN`);
    }
  });

  it("keeps the new column additive and rewrites no existing row", () => {
    const migration = readFileSync(structureMigrationUrl, "utf8");
    // Scan the STATEMENTS, not the file: comments legitimately discuss updates, and the
    // referential action "ON UPDATE CASCADE" contains the word UPDATE without being a DML write.
    const ddl = statements(migration).join("\n");

    expect(ddl).not.toMatch(/^UPDATE\b|\bUPDATE\s+"Attachment"/i);
    expect(ddl).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(ddl).not.toMatch(/\bTRUNCATE\b/i);
    expect(ddl).not.toMatch(/\bINSERT\s+INTO\b/i);
    // Dropping a CONSTRAINT is expected: the lifecycle check is redefined in place. Dropping a
    // column, table or index would destroy data or an invariant.
    expect(ddl).not.toMatch(/\bDROP\s+(COLUMN|TABLE|INDEX)\b/i);
    // The only constraint dropped is the one immediately re-added.
    expect(ddl.match(/DROP CONSTRAINT "[^"]+"/g) ?? []).toEqual(['DROP CONSTRAINT "Attachment_lifecycle_check"']);
    // An additive nullable column must not carry a default, or every existing row is rewritten.
    expect(ddl).not.toMatch(/ADD COLUMN "babyId"[^;]*DEFAULT/i);
    // NOT VALID would leave a constraint unenforced against existing rows.
    expect(ddl).not.toMatch(/NOT VALID/i);
  });
});
