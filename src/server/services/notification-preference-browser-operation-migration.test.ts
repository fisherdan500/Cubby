import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260818110000_membership_episode_notification_preferences";
const migrationUrl = new URL(`../../../prisma/migrations/${migrationDirectory}/migration.sql`, import.meta.url);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);

function block(source: string, kind: "enum" | "model", name: string) {
  return source
    .split(new RegExp(`\\r?\\n(?=${kind}\\s)`))
    .find((candidate) => candidate.startsWith(`${kind} ${name} `)) ?? "";
}

describe("membership-episode preference browser-operation migration", () => {
  it("requires a member-episode preference target for notification preference saves", () => {
    expect(existsSync(migrationUrl)).toBe(true);
    if (!existsSync(migrationUrl)) return;

    const schema = readFileSync(schemaUrl, "utf8");
    expect(block(schema, "enum", "BrowserOperationTargetKind")).toMatch(/\bpreference\b/);
    expect(block(schema, "enum", "BrowserOperationKey")).toContain('@map("notification.preference.save")');

    const migration = readFileSync(migrationUrl, "utf8");
    expect(migration).toContain('DROP CONSTRAINT "BrowserOperationBinding_target_shape_check"');
    expect(migration).toMatch(/WHEN 'notification\.preference\.save' THEN "targetKind" = 'preference' AND "targetId" IS NOT NULL AND "babyId" IS NULL/);
  });
});
