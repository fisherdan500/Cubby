/**
 * The migration that lets a photo post belong to a logged entry.
 *
 * A photo added to an entry stays an ordinary feed photo on a real post, so delivery and backups keep
 * working; the post just records which entry it belongs to. The link must be same-tenant by
 * construction, exactly as FeedComment.activityId already is: a composite foreign key through
 * householdId, not a bare activity id that could point into another household.
 *
 * These assertions parse the migration's statements rather than grepping for substrings, so a
 * constraint written with the right words but the wrong columns fails.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const MIGRATION = "20261001140000_feed_post_activity";

// Resolved from this file, like the other migration-contract tests, so it does not depend on cwd.
const migrationUrl = new URL(`../../../prisma/migrations/${MIGRATION}/migration.sql`, import.meta.url);
const sql = readFileSync(migrationUrl, "utf8");

/** The statements of the migration, semicolon-separated, whitespace-normalized. */
const statements = sql
  .split(";")
  .map((statement) => statement.replace(/--[^\n]*\n/g, " ").replace(/\s+/g, " ").trim())
  .filter(Boolean);

const has = (pattern: RegExp) => statements.some((statement) => pattern.test(statement));

describe("linking a photo post to a logged entry", () => {
  it("adds the column as nullable, because almost every post belongs to no entry", () => {
    expect(
      has(/^ALTER TABLE "FeedPost" ADD COLUMN "activityId" TEXT$/i)
    ).toBe(true);
  });

  it("never makes the column required", () => {
    // An existing post has no entry; requiring it would make the migration unappliable.
    expect(has(/"activityId"[^)]*NOT NULL/i)).toBe(false);
  });

  it("links through the household as well as the entry, so it cannot cross tenants", () => {
    // The same shape FeedComment.activityId uses: a composite key, not a bare activity id.
    expect(
      has(
        /ALTER TABLE "FeedPost" ADD CONSTRAINT "FeedPost_householdId_activityId_fkey" FOREIGN KEY \("householdId", "activityId"\) REFERENCES "ActivityLog"\("householdId", "id"\)/i
      )
    ).toBe(true);
  });

  it("removes the link when the entry is deleted, leaving no post pointing at nothing", () => {
    expect(has(/"FeedPost_householdId_activityId_fkey".*ON DELETE CASCADE/i)).toBe(true);
  });

  it("indexes the lookup Moments actually makes", () => {
    // Moments asks for the photo posts of the entries on the page.
    expect(
      has(/CREATE INDEX "FeedPost_householdId_activityId_idx" ON "FeedPost"\("householdId", "activityId"\)/i)
    ).toBe(true);
  });

  it("does not touch the photo's own ownership", () => {
    // The photo stays a feed photo on its post: delivery and the backup export both require that
    // parent, so this migration must not alter Attachment at all.
    expect(statements.some((statement) => /\bAttachment\b/i.test(statement))).toBe(false);
  });
});
