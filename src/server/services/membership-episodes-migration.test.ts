import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../prisma/migrations/20260729230000_membership_episodes/migration.sql",
  import.meta.url
);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);

describe("membership episode migration contract", () => {
  it("allows removed history while database-enforcing one current household membership per user", () => {
    expect(existsSync(migrationUrl)).toBe(true);

    const migration = readFileSync(migrationUrl, "utf8");
    const schema = readFileSync(schemaUrl, "utf8");

    expect(schema).not.toContain("@@unique([householdId, userId])");
    expect(migration).toContain('DROP INDEX "HouseholdMember_householdId_userId_key"');
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "HouseholdMember_one_current_episode_key"[\s\S]+\("householdId", "userId"\)[\s\S]+WHERE "deletedAt" IS NULL/
    );
    expect(migration).not.toMatch(/UPDATE|DELETE\s+FROM\s+"HouseholdMember"/i);
  });
});
