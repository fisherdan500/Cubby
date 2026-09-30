import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const enumMigrationDirectory = "20260930180000_user_photo_attachment_type";
const structureMigrationDirectory = "20260930180100_user_photo_attachment_ownership";
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

describe("user photo attachment type migration", () => {
  it("adds the enum value in its own migration with no transaction and no use of the new value", () => {
    expect(existsSync(enumMigrationUrl)).toBe(true);

    const migration = readFileSync(enumMigrationUrl, "utf8");

    // PostgreSQL cannot use a new enum value in the same transaction that adds it, so this
    // migration must contain the ALTER TYPE alone and must not open a transaction.
    expect(statements(migration)).toEqual([
      'ALTER TYPE "AttachmentType" ADD VALUE IF NOT EXISTS \'user_photo\';'
    ]);
    expect(migration).not.toMatch(/\bBEGIN;/);
    expect(migration).not.toMatch(/\bCOMMIT;/);
  });

  it("declares user_photo on the schema enum", () => {
    const schema = readFileSync(schemaUrl, "utf8");
    const block = enumBlock(schema, "AttachmentType");

    expect(block).toContain("feed_photo");
    expect(block).toContain("baby_photo");
    expect(block).toContain("user_photo");
  });

  it("adds member ownership with a tenant-safe composite foreign key", () => {
    expect(existsSync(structureMigrationUrl)).toBe(true);

    const migration = readFileSync(structureMigrationUrl, "utf8");
    const sql = compact(migration);

    // Nullable and no default: no existing row is rewritten and every existing attachment stays
    // owned exactly as it was.
    expect(sql).toContain('ALTER TABLE "Attachment" ADD COLUMN "memberId" TEXT;');
    expect(sql).not.toMatch(/ADD COLUMN "memberId" TEXT NOT NULL/);
    expect(sql).not.toMatch(/ADD COLUMN "memberId" TEXT DEFAULT/);

    // The composite key is what makes a cross-household profile picture unrepresentable rather
    // than merely rejected by application code.
    expect(sql).toContain(
      'ADD CONSTRAINT "Attachment_householdId_memberId_fkey" FOREIGN KEY ("householdId", "memberId") REFERENCES "HouseholdMember" ("householdId", "id")'
    );
  });

  it("allows one served picture per membership, scoped to the served state", () => {
    const sql = compact(readFileSync(structureMigrationUrl, "utf8"));

    // Scoped to 'available' rather than to deletedAt: a replaced picture keeps its recovery window
    // in state 'deleted' and must not block its own replacement.
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "Attachment_one_available_user_photo" ON "Attachment"("householdId", "memberId") WHERE "type" = \'user_photo\' AND "state" = \'available\';'
    );
  });

  it("keeps the ownership shapes disjoint without forbidding staging", () => {
    const sql = compact(readFileSync(structureMigrationUrl, "utf8"));

    // A staged attachment has no parent at all, so memberId must be allowed to be NULL while
    // staging. What must never happen is a user photo owned by a post or a baby, another type
    // owned by a member, or a user photo reaching the served state with no member.
    expect(sql).toContain(
      'ADD CONSTRAINT "Attachment_user_photo_parent" CHECK (("type" = \'user_photo\' AND "postId" IS NULL AND "babyId" IS NULL) OR ("type" <> \'user_photo\' AND "memberId" IS NULL));'
    );
    expect(sql).toContain(
      'ADD CONSTRAINT "Attachment_available_user_photo_has_member" CHECK (NOT ("type" = \'user_photo\' AND "state" = \'available\' AND "memberId" IS NULL));'
    );
  });

  it("teaches the lifecycle check about member ownership, keeping every other branch intact", () => {
    const sql = compact(readFileSync(structureMigrationUrl, "utf8"));

    // This is the trap the baby_photo slice hit: the lifecycle CHECK hard-codes what an AVAILABLE
    // attachment must have. Without widening it, a user photo could never leave staging, and no
    // source-level gate would reveal it - only a real deploy would.
    expect(sql).toContain('DROP CONSTRAINT "Attachment_lifecycle_check"');
    expect(sql).toContain(
      'WHEN \'available\' THEN "activatedAt" IS NOT NULL AND "deletedAt" IS NULL AND "purgeAfter" IS NULL AND "purgedAt" IS NULL AND CASE WHEN "type" = \'baby_photo\' THEN "babyId" IS NOT NULL AND "postId" IS NULL AND "position" IS NULL WHEN "type" = \'user_photo\' THEN "memberId" IS NOT NULL AND "postId" IS NULL AND "position" IS NULL ELSE "postId" IS NOT NULL AND "position" IS NOT NULL END'
    );

    // Staging must forbid a member parent too, exactly as it forbids a post and a baby.
    expect(sql).toContain(
      'WHEN \'staging\' THEN "postId" IS NULL AND "position" IS NULL AND "babyId" IS NULL AND "memberId" IS NULL AND "activatedAt" IS NULL'
    );

    // Every state stays enumerated: a CASE with no matching branch yields NULL, and a CHECK treats
    // NULL as satisfied, so a dropped branch silently stops enforcing that state.
    for (const state of ["'staging'", "'available'", "'unavailable'", "'deleted'", "'purged'"]) {
      expect(sql).toContain(`WHEN ${state} THEN`);
    }
  });

  it("declares the member relation on the schema, restricting deletion of a member who owns one", () => {
    const schema = readFileSync(schemaUrl, "utf8");
    const attachment = modelBlock(schema, "Attachment");

    expect(attachment).toMatch(/memberId\s+String\?/);
    // Restrict, not Cascade: removing a person must not silently delete a stored file and orphan
    // its bytes. The service layer refuses with a clear reason instead.
    expect(attachment).toMatch(/member\s+HouseholdMember\?\s+@relation\([^)]*onDelete: Restrict/s);
  });

  it("runs the structural change in one transaction", () => {
    const migration = readFileSync(structureMigrationUrl, "utf8");

    expect(migration).toMatch(/\bBEGIN;/);
    expect(migration).toMatch(/\bCOMMIT;/);
  });
});
