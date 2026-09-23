import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationDirectory = "20260922235500_activity_timer_pause_intervals";
const migrationUrl = new URL(`../../../prisma/migrations/${migrationDirectory}/migration.sql`, import.meta.url);
const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);
const rehearsalUrl = new URL("../../../scripts/integrity-suite.acceptance-rehearsal.ts", import.meta.url);
const semanticUrl = new URL("./activities.semantic.ts", import.meta.url);
const postMigrationFixtureUrls = [
  new URL("../../../scripts/activity-update-safety.integration.test.ts", import.meta.url),
  new URL("../../../scripts/backup-recovery-rehearsal.integration.test.ts", import.meta.url)
];

function migrationSql() {
  expect(existsSync(migrationUrl), `${migrationDirectory}/migration.sql must exist`).toBe(true);
  return readFileSync(migrationUrl, "utf8").replace(/\r\n/g, "\n");
}

function orderedIndex(sql: string, fragment: string, after: number) {
  const index = sql.indexOf(fragment);
  expect(index, `missing migration fragment: ${fragment}`).toBeGreaterThan(after);
  return index;
}

describe("precise activity timer pause interval migration", () => {
  it("declares the tracking boundary and interval relation in Prisma", () => {
    const schema = readFileSync(schemaUrl, "utf8").replace(/\r\n/g, "\n");

    expect(schema).toMatch(/model ActivityLog[\s\S]*?pauseTrackingStartedAt\s+DateTime\?[\s\S]*?pauseTrackingBaselineSeconds\s+Int\?[\s\S]*?pauseIntervals\s+ActivityTimerPauseInterval\[\]/);
    expect(schema).toMatch(/model ActivityTimerPauseInterval \{[\s\S]*?activityId\s+String[\s\S]*?startedAt\s+DateTime[\s\S]*?endedAt\s+DateTime\?[\s\S]*?activity\s+ActivityLog\s+@relation\(fields: \[activityId\], references: \[id\], onDelete: Cascade\)/);
    expect(schema).toMatch(/model ActivityTimerPauseInterval \{[\s\S]*?@@index\(\[activityId, startedAt\]\)[\s\S]*?\}/);
  });

  it("fails closed, records the exact legacy boundary, and enforces one valid open pause", () => {
    const sql = migrationSql();
    let cursor = orderedIndex(sql, "BEGIN;", -1);
    cursor = orderedIndex(sql, "activity_timer_pause_interval_preflight_failed", cursor);
    cursor = orderedIndex(sql, 'ADD COLUMN "pauseTrackingStartedAt" TIMESTAMP(3)', cursor);
    cursor = orderedIndex(sql, 'ADD COLUMN "pauseTrackingBaselineSeconds" INTEGER', cursor);
    cursor = orderedIndex(sql, 'CREATE TABLE "ActivityTimerPauseInterval"', cursor);
    cursor = orderedIndex(sql, 'SET "pauseTrackingStartedAt" = "startedAt"', cursor);
    cursor = orderedIndex(sql, 'SET "pauseTrackingStartedAt" = CURRENT_TIMESTAMP', cursor);
    cursor = orderedIndex(sql, 'INSERT INTO "ActivityTimerPauseInterval"', cursor);
    cursor = orderedIndex(sql, 'ADD CONSTRAINT "ActivityTimerPauseInterval_activityId_fkey"', cursor);
    cursor = orderedIndex(sql, 'ADD CONSTRAINT "ActivityTimerPauseInterval_valid_range_check"', cursor);
    cursor = orderedIndex(sql, 'CREATE UNIQUE INDEX "ActivityTimerPauseInterval_one_open_per_activity"', cursor);
    cursor = orderedIndex(sql, 'GRANT SELECT, INSERT ON TABLE "ActivityTimerPauseInterval" TO cubby_runtime', cursor);
    cursor = orderedIndex(sql, "COMMIT;", cursor);

    expect(sql.slice(cursor + "COMMIT;".length).trim()).toBe("");
    expect(sql).toMatch(/"pausedSeconds" = 0[\s\S]*?"startedAt" IS NOT NULL/);
    expect(sql).toMatch(/SET "pauseTrackingStartedAt" = "startedAt",[\s\S]*?"pauseTrackingBaselineSeconds" = 0/);
    expect(sql).toMatch(/SET "pauseTrackingStartedAt" = CURRENT_TIMESTAMP,[\s\S]*?"pauseTrackingBaselineSeconds" = "pausedSeconds"/);
    expect(sql).toMatch(/"pausedSeconds" > 0[\s\S]*?"timerState" IN \('running', 'paused'\)/);
    expect(sql).toMatch(/"timerState" IN \('running', 'paused', 'stopped'\)[\s\S]*?"startedAt" IS NULL/);
    expect(sql).toMatch(/"timerState" <> 'paused'[\s\S]*?"pausedAt" IS NOT NULL/);
    expect(sql).toMatch(/"timerState" = 'none'[\s\S]*?"pausedSeconds" <> 0/);
    expect(sql).toMatch(/"timerState" IN \('running', 'paused'\)[\s\S]*?"endedAt" IS NOT NULL/);
    expect(sql).toMatch(/"timerState" = 'stopped'[\s\S]*?"endedAt" IS NULL[\s\S]*?"durationSeconds" IS NULL/);
    expect(sql).toMatch(/"timerState" IN \('running', 'paused'\)\s+AND "pausedSeconds" > 0\s+AND "startedAt" > CURRENT_TIMESTAMP/);
    expect(sql).toContain("GREATEST(");
    expect(sql).toMatch(/ROUND\(EXTRACT\(EPOCH FROM \(activity\."endedAt" - activity\."startedAt"\)\)\)/);
    expect(sql).toMatch(/"pausedSeconds" = 0[\s\S]*?"timerState" IN \('running', 'paused'\)/);
    expect(sql).toMatch(/"timerState" = 'stopped'[\s\S]*?ROUND\(EXTRACT\(EPOCH FROM "endedAt"\)\) - ROUND\(EXTRACT\(EPOCH FROM "startedAt"\)\)/);
    expect(sql).toMatch(/WHERE "timerState" = 'paused'[\s\S]*?"pausedAt" IS NOT NULL/);
    expect(sql).toMatch(/CHECK \("endedAt" IS NULL OR "endedAt" >= "startedAt"\)/);
    expect(sql).toMatch(/WHERE "endedAt" IS NULL/);
    expect(sql).toMatch(/ON DELETE CASCADE ON UPDATE CASCADE/);
  });

  it("defers parent-child coherence checks until transaction commit", () => {
    const sql = migrationSql();

    expect(sql).toContain("activity_timer_pause_integrity_failed");
    expect(sql).toMatch(/CREATE FUNCTION "assertActivityTimerPauseIntegrity"/);
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER "ActivityLog_pause_integrity"[\s\S]*?DEFERRABLE INITIALLY DEFERRED/);
    expect(sql).toMatch(/CREATE CONSTRAINT TRIGGER "ActivityTimerPauseInterval_pause_integrity"[\s\S]*?DEFERRABLE INITIALLY DEFERRED/);
    expect(sql).toMatch(/"timerState" = 'paused'[\s\S]*?open_count <> 1/);
    expect(sql).toMatch(/open_started_at IS DISTINCT FROM activity\."pausedAt"/);
    expect(sql).toMatch(/"timerState" <> 'paused'[\s\S]*?open_count <> 0/);
    expect(sql).toMatch(/pause\."startedAt" < activity\."startedAt"/);
    expect(sql).toMatch(/pause\."endedAt" < activity\."pauseTrackingStartedAt"/);
    expect(sql).toMatch(/tsrange\([\s\S]*?&&[\s\S]*?tsrange\(/);
    expect(sql).toMatch(/SUM\(ROUND\(EXTRACT\(EPOCH FROM "endedAt"\)\) - ROUND\(EXTRACT\(EPOCH FROM "startedAt"\)\)\)/);
    expect(sql).toMatch(/closed_pause_seconds\s*<> activity\."pausedSeconds" - activity\."pauseTrackingBaselineSeconds"/);
    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS btree_gist");
    expect(sql).toMatch(/EXCLUDE USING GIST[\s\S]*?"activityId" WITH =[\s\S]*?tsrange[\s\S]*?WITH &&/);
    expect(sql).toContain('CREATE FUNCTION "serializeActivityTimerPauseWrite"');
    expect(sql).toMatch(/CREATE TRIGGER "ActivityTimerPauseInterval_serialize"[\s\S]*?BEFORE INSERT OR UPDATE OR DELETE/);
    expect(sql).toContain('CREATE FUNCTION "protectActivityTimerPauseInterval"');
    expect(sql).toMatch(/OLD\."endedAt" IS NOT NULL[\s\S]*?NEW\."endedAt" IS NULL[\s\S]*?activity_timer_pause_interval_immutable/);
    expect(sql).toContain('CREATE FUNCTION "protectActivityTimerPauseIntervalInsert"');
    expect(sql).toMatch(/NEW\."endedAt" IS NOT NULL[\s\S]*?activity_timer_pause_interval_closed_insert/);
    expect(sql).toContain('CREATE FUNCTION "closeActivityTimerPauseInterval"');
    expect(sql).toMatch(/SECURITY DEFINER[\s\S]*?FOR UPDATE[\s\S]*?UPDATE public\."ActivityTimerPauseInterval"/);
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION "closeActivityTimerPauseInterval"');
    expect(sql).toContain('GRANT SELECT, INSERT ON TABLE "ActivityTimerPauseInterval"');
    expect(sql).not.toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ActivityTimerPauseInterval"');
    expect(sql).toMatch(/FOR migrated_activity_id IN[\s\S]*?assertActivityTimerPauseIntegrity/);
  });

  it("grants the application runtime access to the new child table when that role exists", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'cubby_runtime'\)/);
    expect(sql).toContain(
      'GRANT SELECT, INSERT ON TABLE "ActivityTimerPauseInterval" TO cubby_runtime'
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION "closeActivityTimerPauseInterval"(TEXT, TIMESTAMP) TO cubby_runtime'
    );
  });

  it("wires a predecessor-only rollback and restricted-role constraint rehearsal", () => {
    const rehearsal = readFileSync(rehearsalUrl, "utf8");

    expect(rehearsal).toContain(`const pauseTargetMigration = "${migrationDirectory}"`);
    expect(rehearsal).toContain("cubby_integrity_acceptance:${password}@127.0.0.1");
    expect(rehearsal).not.toContain("cubby_integrity_acceptance:***@127.0.0.1");
    expect(rehearsal).toContain("activity_timer_pause_interval_preflight_failed");
    expect(rehearsal).toContain("activity_timer_pause_rollback_incomplete");
    expect(rehearsal).toContain("runPauseIntervalMigrationRollbackCase");
    expect(rehearsal).toContain("ActivityTimerPauseInterval_one_open_per_activity");
    expect(rehearsal).toContain("activity_timer_pause_backfill_invalid");
    expect(rehearsal).toContain("activity_timer_pause_overlap_signal_missing");
    expect(rehearsal).toContain("activity_timer_pause_envelope_signal_missing");
    expect(rehearsal).toContain("pauseTrackingBaselineSeconds");
    expect(rehearsal).toContain("runPauseIntervalConcurrencyAcceptance");
    expect(rehearsal).toContain("pg_blocking_pids");
    expect(rehearsal).toContain("integrity-concurrency-parent");
    expect(rehearsal).toContain("activity_timer_pause_concurrent_child_write_unblocked");
    expect(rehearsal).toContain("activity_timer_pause_concurrency_final_state_invalid");
    expect(rehearsal).toContain("activity_timer_pause_partial_running_update_not_rejected");
    expect(rehearsal).toContain("activity_timer_pause_partial_running_delete_not_rejected");
    expect(rehearsal).toContain("activity_timer_pause_partial_paused_delete_not_rejected");
    expect(rehearsal).toContain("activity_timer_pause_partial_stopped_update_not_rejected");
    for (const id of ["integrity-backfill-zero", "integrity-backfill-zero-mismatch", "integrity-backfill-predecessor-rounding", "integrity-backfill-running", "integrity-backfill-stopped", "integrity-backfill-paused"]) {
      expect(rehearsal).toContain(id);
    }
    expect(rehearsal).toContain("has_table_privilege('cubby_runtime'");
  });

  it("declares pause-interval child writes in every timer operation semantic", () => {
    const semantic = readFileSync(semanticUrl, "utf8");

    for (const operationId of ["activity.timer.pause", "activity.timer.resume", "activity.timer.stop"]) {
      const start = semantic.indexOf(`id: "${operationId}"`);
      expect(start).toBeGreaterThan(-1);
      const next = semantic.indexOf("}, {", start);
      expect(semantic.slice(start, next === -1 ? undefined : next)).toContain("ActivityTimerPauseInterval");
    }
  });

  it("initializes precise tracking on every post-migration running-timer fixture", () => {
    for (const fixtureUrl of postMigrationFixtureUrls) {
      const source = readFileSync(fixtureUrl, "utf8");
      const directCreates = [...source.matchAll(/prisma\.activityLog\.create\(\{\s*data:\s*\{([\s\S]*?)\n\s*\}\s*\}\);/g)]
        .map((match) => match[1])
        .filter((body) => /timerState:\s*TimerState\.running/.test(body));
      expect(directCreates.length).toBeGreaterThan(0);
      for (const body of directCreates) {
        expect(body).toContain("pauseTrackingStartedAt:");
        expect(body).toMatch(/pauseTrackingBaselineSeconds:\s*0/);
      }
    }
  });

  it("round-trips a tracked stopped timer through the PostgreSQL backup rehearsal", () => {
    const backupFixture = readFileSync(postMigrationFixtureUrls[1], "utf8").replace(/\r\n/g, "\n");
    expect(backupFixture).toMatch(/pauseIntervals:\s*\{\s*create:/);
    expect(backupFixture).toContain("pauseTrackingBaselineSeconds: 0");
    expect(backupFixture).toMatch(/pauseIntervals:\s*\{\s*orderBy:/);
  });
});
