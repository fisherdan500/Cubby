import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { createDisposableRuntimeRolesArgs } from "./disposable-runtime-roles";

// Disposable acceptance gate for the read-only integrity suite: it boots its own Postgres, applies the
// real migrations, and runs every database check against seeded clean data and seeded violations. A
// check whose SQL cannot run is reported as "incomplete" rather than thrown, so executing the queries
// against the real schema is the only thing that tells a working check from a silently broken one.
//
// Nothing here touches the normal runtime: its own Compose project, database, volume and network, and
// no .env.

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const composeFile = "scripts/integrity-suite.acceptance.compose.yml";
const database = "cubby_integrity_acceptance";
const targetMigration = "20260922194500_calendar_event_tenant_constraints";
const pauseTargetMigration = "20260922235500_activity_timer_pause_intervals";

function run(command: string, args: string[], env: NodeJS.ProcessEnv, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (result.error || result.status !== 0) throw new Error(`integrity_suite_acceptance_failed: ${command} ${args.join(" ")}`);
  return String(result.stdout ?? "");
}

function runExpectingFailure(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error || result.status === 0) throw new Error("integrity_suite_expected_migration_failure_missing");
  return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
}

function runSql(compose: string[], env: NodeJS.ProcessEnv, sql: string, capture = false) {
  return run("docker", [
    ...compose,
    "exec", "--no-TTY", "postgres",
    "psql", "--username", database, "--dbname", database,
    "--set", "ON_ERROR_STOP=1", "--no-align", "--tuples-only", "--command", sql
  ], env, capture);
}

function runSqlExpectingFailure(compose: string[], env: NodeJS.ProcessEnv, sql: string) {
  return runExpectingFailure("docker", [
    ...compose,
    "exec", "--no-TTY", "postgres",
    "psql", "--username", database, "--dbname", database,
    "--set", "ON_ERROR_STOP=1", "--no-align", "--tuples-only", "--command", sql
  ], env);
}

/**
 * Runs a migration's own SQL through psql, which stops at the first error and reports it. The Prisma
 * migrator keeps sending statements after a failure inside the migration's BEGIN, so all it can report
 * is the "current transaction is aborted" that follows: a preflight's marker never reaches its output.
 */
function runMigrationSqlExpectingFailure(compose: string[], env: NodeJS.ProcessEnv, migrationPath: string) {
  return runSqlExpectingFailure(compose, env, readFileSync(resolve(migrationPath, "migration.sql"), "utf8"));
}

function startSqlSession(compose: string[], env: NodeJS.ProcessEnv, sql: string) {
  const child = spawn("docker", [
    ...compose,
    "exec", "--no-TTY", "postgres",
    "psql", "--username", database, "--dbname", database,
    "--set", "ON_ERROR_STOP=1", "--no-align", "--tuples-only", "--command", sql
  ], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { output += chunk; });
  const completion = new Promise<{ status: number | null; output: string }>((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion);
    child.once("close", (status) => resolveCompletion({ status, output }));
  });
  return { completion };
}

function waitForSqlSessionSleeping(
  compose: string[],
  env: NodeJS.ProcessEnv,
  applicationName: string,
  failureMarker: string
) {
  runSql(compose, env, `
DO $$
BEGIN
  FOR attempt IN 1..250 LOOP
    -- pg_stat_activity is read once per transaction and this whole loop is one; without clearing the
    -- snapshot every pass sees the first one, and a session that was not yet there never appears.
    PERFORM pg_stat_clear_snapshot();
    IF EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE application_name = '${applicationName}'
        AND state = 'active'
        AND wait_event = 'PgSleep'
    ) THEN
      RETURN;
    END IF;
    PERFORM pg_sleep(0.1);
  END LOOP;
  RAISE EXCEPTION '${failureMarker}';
END $$;`);
}

function assertSqlSessionBlocked(
  compose: string[],
  env: NodeJS.ProcessEnv,
  applicationName: string,
  failureMarker: string
) {
  // Up to 25 s: the second session is started through `docker compose exec`, which on a busy CI runner
  // can take several seconds to connect. The session holding the lock sleeps 30 s, so
  // the second one is still waiting on it when it arrives.
  runSql(compose, env, `
DO $$
DECLARE
  target_pid INTEGER;
BEGIN
  FOR attempt IN 1..250 LOOP
    PERFORM pg_stat_clear_snapshot();
    SELECT pid INTO target_pid FROM pg_stat_activity
    WHERE application_name = '${applicationName}'
    ORDER BY backend_start DESC
    LIMIT 1;
    IF target_pid IS NOT NULL AND cardinality(pg_blocking_pids(target_pid)) > 0 THEN
      RETURN;
    END IF;
    PERFORM pg_sleep(0.1);
  END LOOP;
  RAISE EXCEPTION '${failureMarker}';
END $$;`);
}

function holdMigrationsFrom(migrationsPath: string, target: string, heldRoot: string) {
  mkdirSync(heldRoot, { recursive: true });
  const names = readdirSync(migrationsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name >= target)
    .map((entry) => entry.name)
    .sort();
  if (!names.includes(target)) throw new Error(`integrity_suite_target_migration_missing:${target}`);
  for (const name of names) renameSync(resolve(migrationsPath, name), resolve(heldRoot, name));
  return names;
}

function restoreHeldMigration(name: string, migrationsPath: string, heldRoot: string) {
  renameSync(resolve(heldRoot, name), resolve(migrationsPath, name));
}

const calendarTenantBaselineSql = `
INSERT INTO "Household" ("id", "name", "createdByUserId", "createdAt", "updatedAt") VALUES
  ('integrity-household-a', 'Household A', 'synthetic-user-a', NOW(), NOW()),
  ('integrity-household-b', 'Household B', 'synthetic-user-b', NOW(), NOW());
INSERT INTO "Baby" ("id", "householdId", "name", "timezone", "createdAt", "updatedAt") VALUES
  ('integrity-baby-a', 'integrity-household-a', 'Baby A', 'UTC', NOW(), NOW()),
  ('integrity-baby-b', 'integrity-household-b', 'Baby B', 'UTC', NOW(), NOW());
INSERT INTO "Contact" ("id", "householdId", "name", "createdAt", "updatedAt") VALUES
  ('integrity-contact-a', 'integrity-household-a', 'Contact A', NOW(), NOW()),
  ('integrity-contact-b', 'integrity-household-b', 'Contact B', NOW(), NOW());
INSERT INTO "CalendarEvent" ("id", "householdId", "title", "startTime", "createdAt", "updatedAt") VALUES
  ('integrity-event-a', 'integrity-household-a', 'Event A', NOW(), NOW(), NOW()),
  ('integrity-event-b', 'integrity-household-b', 'Event B', NOW(), NOW(), NOW());
-- The actor the synthetic activities below name. Written past the membership triggers, as the
-- activities are, but it has to exist: the pause-interval triggers update those activities inside
-- ordinary transactions, where the foreign key to their actor is checked again.
SET session_replication_role = replica;
INSERT INTO "User" ("id", "name", "email", "createdAt", "updatedAt") VALUES
  ('synthetic-user-a', 'Synthetic Actor', 'synthetic-actor@acceptance.invalid', NOW(), NOW());
INSERT INTO "HouseholdMember" ("id", "householdId", "userId", "role", "updatedAt") VALUES
  ('synthetic-member', 'integrity-household-a', 'synthetic-user-a', 'owner', NOW());
SET session_replication_role = origin;`;

const calendarTenantRollbackStateSql = `
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('CalendarEventBaby', 'CalendarEventContact')
      AND column_name = 'householdId')
  || '|' ||
  (SELECT COUNT(*) FROM pg_constraint WHERE conname IN (
    'CalendarEvent_householdId_id_key',
    'Contact_householdId_id_key',
    'CalendarEventBaby_householdId_babyId_fkey',
    'CalendarEventBaby_householdId_eventId_fkey',
    'CalendarEventContact_householdId_contactId_fkey',
    'CalendarEventContact_householdId_eventId_fkey'
  ))
  || '|' ||
  (SELECT COUNT(*) FROM pg_indexes WHERE indexname IN (
    'CalendarEventBaby_householdId_idx',
    'CalendarEventContact_householdId_idx'
  ));`;

const calendarTenantRollbackCases = [
  {
    name: "baby_tenant_mismatch",
    marker: "tenant_relationship_preflight_failed:calendar_event_baby",
    insertSql: `INSERT INTO "CalendarEventBaby" ("babyId", "eventId") VALUES ('integrity-baby-b', 'integrity-event-a');`,
    cleanupSql: `DELETE FROM "CalendarEventBaby" WHERE "babyId" = 'integrity-baby-b' AND "eventId" = 'integrity-event-a';`
  },
  {
    name: "contact_tenant_mismatch",
    marker: "tenant_relationship_preflight_failed:calendar_event_contact",
    insertSql: `INSERT INTO "CalendarEventContact" ("contactId", "eventId") VALUES ('integrity-contact-b', 'integrity-event-a');`,
    cleanupSql: `DELETE FROM "CalendarEventContact" WHERE "contactId" = 'integrity-contact-b' AND "eventId" = 'integrity-event-a';`
  },
  {
    name: "baby_orphan",
    marker: "tenant_relationship_preflight_failed:calendar_event_baby",
    insertSql: `SET session_replication_role = replica; INSERT INTO "CalendarEventBaby" ("babyId", "eventId") VALUES ('missing-baby', 'integrity-event-a'); SET session_replication_role = origin;`,
    cleanupSql: `DELETE FROM "CalendarEventBaby" WHERE "babyId" = 'missing-baby' AND "eventId" = 'integrity-event-a';`
  },
  {
    name: "contact_orphan",
    marker: "tenant_relationship_preflight_failed:calendar_event_contact",
    insertSql: `SET session_replication_role = replica; INSERT INTO "CalendarEventContact" ("contactId", "eventId") VALUES ('missing-contact', 'integrity-event-a'); SET session_replication_role = origin;`,
    cleanupSql: `DELETE FROM "CalendarEventContact" WHERE "contactId" = 'missing-contact' AND "eventId" = 'integrity-event-a';`
  }
] as const;

function assertCalendarTenantMigrationRolledBack(compose: string[], env: NodeJS.ProcessEnv) {
  const state = runSql(compose, env, calendarTenantRollbackStateSql, true).trim();
  if (state !== "0|0|0") throw new Error(`calendar_event_tenant_rollback_incomplete:${state}`);
}

function runTargetMigrationRollbackCases(
  compose: string[],
  env: NodeJS.ProcessEnv,
  databaseUrl: string,
  prismaCli: string,
  targetMigrationPath: string
) {
  const schemaPath = resolve(targetMigrationPath, "..", "..", "schema.prisma");
  const migrationEnv = { ...env, DATABASE_URL: databaseUrl };
  runSql(compose, env, calendarTenantBaselineSql);

  for (const scenario of calendarTenantRollbackCases) {
    runSql(compose, env, scenario.insertSql);
    try {
      const refusal = runMigrationSqlExpectingFailure(compose, env, targetMigrationPath);
      if (!refusal.includes(scenario.marker)) {
        throw new Error(`calendar_event_tenant_preflight_marker_missing:${scenario.name}\n${refusal.slice(-2000)}`);
      }
      assertCalendarTenantMigrationRolledBack(compose, env);
      // The migrator must refuse the same data too, and leave nothing applied behind it.
      runExpectingFailure(process.execPath, [prismaCli, "migrate", "deploy", "--schema", schemaPath], migrationEnv);
      assertCalendarTenantMigrationRolledBack(compose, env);
    } finally {
      runSql(compose, env, scenario.cleanupSql);
    }
    run(process.execPath, [prismaCli, "migrate", "resolve", "--rolled-back", targetMigration, "--schema", schemaPath], migrationEnv);
    process.stdout.write(`INTEGRITY_CALENDAR_TENANT_${scenario.name.toUpperCase()}_ROLLBACK_PASS\n`);
  }

  run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", schemaPath], migrationEnv);
}

const pauseRollbackStateSql = `
SELECT
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ActivityLog' AND column_name = 'pauseTrackingStartedAt')
  || '|' ||
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ActivityLog' AND column_name = 'pauseTrackingBaselineSeconds')
  || '|' ||
  (SELECT COUNT(*) FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ActivityTimerPauseInterval')
  || '|' ||
  (SELECT COUNT(*) FROM pg_indexes
    WHERE indexname = 'ActivityTimerPauseInterval_one_open_per_activity');`;

function assertPauseIntervalMigrationRolledBack(compose: string[], env: NodeJS.ProcessEnv) {
  const state = runSql(compose, env, pauseRollbackStateSql, true).trim();
  if (state !== "0|0|0|0") throw new Error(`activity_timer_pause_rollback_incomplete:${state}`);
}

function runPauseIntervalPostMigrationAcceptance(compose: string[], env: NodeJS.ProcessEnv) {
  const privileges = runSql(compose, env, `
SELECT
  has_table_privilege('cubby_runtime', '"ActivityTimerPauseInterval"', 'SELECT') || '|' ||
  has_table_privilege('cubby_runtime', '"ActivityTimerPauseInterval"', 'INSERT') || '|' ||
  has_table_privilege('cubby_runtime', '"ActivityTimerPauseInterval"', 'UPDATE') || '|' ||
  has_table_privilege('cubby_runtime', '"ActivityTimerPauseInterval"', 'DELETE') || '|' ||
  has_function_privilege('cubby_runtime', '"closeActivityTimerPauseInterval"(text,timestamp)', 'EXECUTE');`, true).trim();
  // A boolean joined onto text is cast to text, which PostgreSQL spells out in full.
  if (privileges !== "true|true|false|false|true") throw new Error(`activity_timer_pause_runtime_privileges_invalid:${privileges}`);

  runSql(compose, env, `
SET session_replication_role = replica;
INSERT INTO "ActivityLog" (
  "id", "householdId", "babyId", "actorMemberId", "type", "occurredAt", "timezone", "source",
  "timerState", "startedAt", "pausedAt", "pausedSeconds", "pauseTrackingStartedAt",
  "pauseTrackingBaselineSeconds", "createdAt", "updatedAt"
) VALUES (
  'integrity-pause-activity', 'integrity-household-a', 'integrity-baby-a', 'synthetic-member', 'sleep',
  '2026-01-01T00:00:00.000Z', 'UTC', 'manual', 'paused', '2026-01-01T00:00:00.000Z',
  '2026-01-01T00:30:00.000Z', 0, '2026-01-01T00:00:00.000Z', 0, NOW(), NOW()
);
SET session_replication_role = origin;
SET ROLE cubby_runtime;
INSERT INTO "ActivityTimerPauseInterval" ("id", "activityId", "startedAt", "createdAt")
VALUES ('integrity-open-pause-1', 'integrity-pause-activity', '2026-01-01T00:30:00.000Z', NOW());
RESET ROLE;`);

  const duplicateOpenFailure = runSqlExpectingFailure(compose, env, `
SET ROLE cubby_runtime;
INSERT INTO "ActivityTimerPauseInterval" ("id", "activityId", "startedAt", "createdAt")
VALUES ('integrity-open-pause-2', 'integrity-pause-activity', '2026-01-01T00:45:00.000Z', NOW());`);
  if (
    !duplicateOpenFailure.includes("ActivityTimerPauseInterval_one_open_per_activity") &&
    !duplicateOpenFailure.includes("ActivityTimerPauseInterval_no_overlap")
  ) {
    throw new Error("activity_timer_pause_open_unique_signal_missing");
  }

  const incoherentCloseFailure = runSqlExpectingFailure(compose, env, `
SET ROLE cubby_runtime;
SELECT "closeActivityTimerPauseInterval"('integrity-pause-activity', '2026-01-01T00:40:00.000Z');`);
  if (!incoherentCloseFailure.includes("activity_timer_pause_integrity_failed")) {
    throw new Error("activity_timer_pause_parent_child_signal_missing");
  }

  runSql(compose, env, `
BEGIN;
SET ROLE cubby_runtime;
UPDATE "ActivityLog"
SET "timerState" = 'running', "pausedAt" = NULL, "pausedSeconds" = 600, "updatedAt" = NOW()
WHERE "id" = 'integrity-pause-activity';
SELECT "closeActivityTimerPauseInterval"('integrity-pause-activity', '2026-01-01T00:40:00.000Z');
COMMIT;

BEGIN;
UPDATE "ActivityLog"
SET "timerState" = 'paused', "pausedAt" = '2026-01-01T00:45:00.000Z', "updatedAt" = NOW()
WHERE "id" = 'integrity-pause-activity';
INSERT INTO "ActivityTimerPauseInterval" ("id", "activityId", "startedAt", "createdAt")
VALUES ('integrity-open-pause-2', 'integrity-pause-activity', '2026-01-01T00:45:00.000Z', NOW());
COMMIT;
RESET ROLE;`);

  const incoherentDeleteFailure = runSqlExpectingFailure(compose, env, `
SET ROLE cubby_runtime;
DELETE FROM "ActivityTimerPauseInterval" WHERE "id" = 'integrity-open-pause-2';`);
  if (!incoherentDeleteFailure.includes("permission denied")) {
    throw new Error("activity_timer_pause_delete_signal_missing");
  }

  runSql(compose, env, `
BEGIN;
SET ROLE cubby_runtime;
UPDATE "ActivityLog"
SET "timerState" = 'stopped', "pausedAt" = NULL, "pausedSeconds" = 1500,
  "endedAt" = '2026-01-01T01:00:00.000Z', "durationSeconds" = 2100, "updatedAt" = NOW()
WHERE "id" = 'integrity-pause-activity';
SELECT "closeActivityTimerPauseInterval"('integrity-pause-activity', '2026-01-01T01:00:00.000Z');
COMMIT;
RESET ROLE;`);

  const invalidRangeFailure = runSqlExpectingFailure(compose, env, `
SET session_replication_role = replica;
INSERT INTO "ActivityTimerPauseInterval" ("id", "activityId", "startedAt", "endedAt", "createdAt")
VALUES ('integrity-invalid-pause', 'integrity-pause-activity', '2026-01-01T01:00:00.000Z', '2026-01-01T00:59:00.000Z', NOW());`);
  if (!invalidRangeFailure.includes("ActivityTimerPauseInterval_valid_range_check")) {
    throw new Error("activity_timer_pause_range_signal_missing");
  }

  const overlapFailure = runSqlExpectingFailure(compose, env, `
BEGIN;
SET session_replication_role = replica;
UPDATE "ActivityLog"
SET "pausedSeconds" = 1560, "durationSeconds" = 2040, "updatedAt" = NOW()
WHERE "id" = 'integrity-pause-activity';
INSERT INTO "ActivityTimerPauseInterval" ("id", "activityId", "startedAt", "endedAt", "createdAt")
VALUES ('integrity-overlap-pause', 'integrity-pause-activity', '2026-01-01T00:35:00.000Z', '2026-01-01T00:36:00.000Z', NOW());
COMMIT;`);
  if (
    !overlapFailure.includes("ActivityTimerPauseInterval_no_overlap") &&
    !overlapFailure.includes("activity_timer_pause_integrity_failed")
  ) {
    throw new Error("activity_timer_pause_overlap_signal_missing");
  }

  // A timer with no pauses yet, so a pause starting before the timer did overlaps nothing and only the
  // envelope rule can refuse it. On the activity above, the overlap guard would answer first.
  runSql(compose, env, `
SET session_replication_role = replica;
INSERT INTO "ActivityLog" (
  "id", "householdId", "babyId", "actorMemberId", "type", "occurredAt", "timezone", "source",
  "timerState", "startedAt", "pausedSeconds", "pauseTrackingStartedAt", "pauseTrackingBaselineSeconds",
  "createdAt", "updatedAt"
) VALUES (
  'integrity-envelope-activity', 'integrity-household-a', 'integrity-baby-a', 'synthetic-member', 'sleep',
  '2026-01-03T00:00:00.000Z', 'UTC', 'manual', 'running', '2026-01-03T00:00:00.000Z', 0,
  '2026-01-03T00:00:00.000Z', 0, NOW(), NOW()
);
SET session_replication_role = origin;`);
  const envelopeFailure = runSqlExpectingFailure(compose, env, `
BEGIN;
SET ROLE cubby_runtime;
UPDATE "ActivityLog" SET "timerState" = 'paused', "pausedAt" = '2026-01-02T23:59:00.000Z', "updatedAt" = NOW()
WHERE "id" = 'integrity-envelope-activity';
INSERT INTO "ActivityTimerPauseInterval" ("id", "activityId", "startedAt", "createdAt")
VALUES ('integrity-outside-pause', 'integrity-envelope-activity', '2026-01-02T23:59:00.000Z', NOW());
COMMIT;`);
  if (!envelopeFailure.includes("activity_timer_pause_integrity_failed")) {
    throw new Error(`activity_timer_pause_envelope_signal_missing\n${envelopeFailure.slice(-1500)}`);
  }
  runSql(compose, env, `DELETE FROM "ActivityLog" WHERE "id" = 'integrity-envelope-activity';`);

  runSql(compose, env, `DELETE FROM "ActivityLog" WHERE "id" = 'integrity-pause-activity';`);
  const remaining = runSql(compose, env, `SELECT COUNT(*) FROM "ActivityTimerPauseInterval" WHERE "activityId" = 'integrity-pause-activity';`, true).trim();
  if (remaining !== "0") throw new Error(`activity_timer_pause_cascade_incomplete:${remaining}`);
}

async function runPauseIntervalConcurrencyAcceptance(compose: string[], env: NodeJS.ProcessEnv) {
  runSql(compose, env, `
BEGIN;
SET session_replication_role = replica;
INSERT INTO "ActivityLog" (
  "id", "householdId", "babyId", "actorMemberId", "type", "occurredAt", "timezone", "source",
  "timerState", "startedAt", "pausedAt", "pausedSeconds", "pauseTrackingStartedAt",
  "pauseTrackingBaselineSeconds", "createdAt", "updatedAt"
) VALUES (
  'integrity-concurrency-parent', 'integrity-household-a', 'integrity-baby-a', 'synthetic-member', 'sleep',
  '2026-01-02T00:00:00.000Z', 'UTC', 'manual', 'paused', '2026-01-02T00:00:00.000Z',
  '2026-01-02T00:45:00.000Z', 900, '2026-01-02T00:20:00.000Z', 300, NOW(), NOW()
);
SET session_replication_role = origin;
SET ROLE cubby_runtime;
INSERT INTO "ActivityTimerPauseInterval" ("id", "activityId", "startedAt", "endedAt", "createdAt")
VALUES (
  'integrity-concurrency-pause-1', 'integrity-concurrency-parent',
  '2026-01-02T00:30:00.000Z', '2026-01-02T00:40:00.000Z', NOW()
);
INSERT INTO "ActivityTimerPauseInterval" ("id", "activityId", "startedAt", "createdAt")
VALUES ('integrity-concurrency-open', 'integrity-concurrency-parent', '2026-01-02T00:45:00.000Z', NOW());
COMMIT;
RESET ROLE;`);

  const childLockSession = startSqlSession(compose, env, `
SET application_name = 'cubby_pause_parent_lock';
BEGIN;
SET ROLE cubby_runtime;
UPDATE "ActivityLog"
SET "timerState" = 'running', "pausedAt" = NULL, "pausedSeconds" = 1200, "updatedAt" = NOW()
WHERE "id" = 'integrity-concurrency-parent';
SELECT "closeActivityTimerPauseInterval"('integrity-concurrency-parent', '2026-01-02T00:50:00.000Z');
SELECT pg_sleep(30);
COMMIT;`);
  waitForSqlSessionSleeping(
    compose, env, "cubby_pause_parent_lock", "activity_timer_pause_parent_lock_not_held"
  );
  const parentWriter = startSqlSession(compose, env, `
SET application_name = 'cubby_pause_parent_writer';
BEGIN;
SET ROLE cubby_runtime;
UPDATE "ActivityLog" SET "notes" = 'serialized-parent-writer'
WHERE "id" = 'integrity-concurrency-parent';
COMMIT;`);
  assertSqlSessionBlocked(
    compose, env, "cubby_pause_parent_writer", "activity_timer_pause_concurrent_parent_write_unblocked"
  );
  const [childLockResult, parentWriterResult] = await Promise.all([
    childLockSession.completion,
    parentWriter.completion
  ]);
  if (childLockResult.status !== 0 || parentWriterResult.status !== 0) {
    throw new Error(`activity_timer_pause_parent_child_concurrency_failed:${childLockResult.output}:${parentWriterResult.output}`);
  }

  const runningUpdateFailure = runSqlExpectingFailure(compose, env, `
SET ROLE cubby_runtime;
UPDATE "ActivityTimerPauseInterval" SET "endedAt" = '2026-01-02T00:39:00.000Z'
WHERE "id" = 'integrity-concurrency-pause-1';`);
  if (!runningUpdateFailure.includes("permission denied")) {
    throw new Error("activity_timer_pause_partial_running_update_not_rejected");
  }
  const runningDeleteFailure = runSqlExpectingFailure(compose, env, `
SET ROLE cubby_runtime;
DELETE FROM "ActivityTimerPauseInterval" WHERE "id" = 'integrity-concurrency-pause-1';`);
  if (!runningDeleteFailure.includes("permission denied")) {
    throw new Error("activity_timer_pause_partial_running_delete_not_rejected");
  }

  const coherentChildWriter = startSqlSession(compose, env, `
SET application_name = 'cubby_pause_child_lock';
BEGIN;
SET ROLE cubby_runtime;
UPDATE "ActivityLog"
SET "timerState" = 'paused', "pausedAt" = '2026-01-02T00:55:00.000Z', "updatedAt" = NOW()
WHERE "id" = 'integrity-concurrency-parent';
INSERT INTO "ActivityTimerPauseInterval" ("id", "activityId", "startedAt", "createdAt")
VALUES (
  'integrity-concurrency-pause-2', 'integrity-concurrency-parent',
  '2026-01-02T00:55:00.000Z', NOW()
);
SELECT pg_sleep(30);
COMMIT;`);
  waitForSqlSessionSleeping(
    compose, env, "cubby_pause_child_lock", "activity_timer_pause_child_lock_not_held"
  );
  const conflictingChildWriter = startSqlSession(compose, env, `
SET application_name = 'cubby_pause_child_writer';
BEGIN;
SET ROLE cubby_runtime;
INSERT INTO "ActivityTimerPauseInterval" ("id", "activityId", "startedAt", "createdAt")
VALUES (
  'integrity-concurrency-pause-3', 'integrity-concurrency-parent',
  '2026-01-02T01:00:00.000Z', NOW()
);
COMMIT;`);
  assertSqlSessionBlocked(
    compose, env, "cubby_pause_child_writer", "activity_timer_pause_concurrent_child_write_unblocked"
  );
  const [coherentResult, conflictingResult] = await Promise.all([
    coherentChildWriter.completion,
    conflictingChildWriter.completion
  ]);
  if (coherentResult.status !== 0) {
    throw new Error(`activity_timer_pause_coherent_child_writer_failed:${coherentResult.output}`);
  }
  if (
    conflictingResult.status === 0 ||
    (!conflictingResult.output.includes("ActivityTimerPauseInterval_one_open_per_activity") &&
      !conflictingResult.output.includes("ActivityTimerPauseInterval_no_overlap"))
  ) {
    throw new Error(`activity_timer_pause_conflicting_child_writer_not_rejected:${conflictingResult.output}`);
  }

  const finalState = runSql(compose, env, `
SELECT activity."pausedSeconds" || '|' || activity."pauseTrackingBaselineSeconds" || '|' ||
  COUNT(pause.id) || '|' ||
  COALESCE(SUM(ROUND(EXTRACT(EPOCH FROM pause."endedAt")) - ROUND(EXTRACT(EPOCH FROM pause."startedAt"))), 0)
FROM "ActivityLog" activity
LEFT JOIN "ActivityTimerPauseInterval" pause ON pause."activityId" = activity.id
WHERE activity.id = 'integrity-concurrency-parent'
GROUP BY activity."pausedSeconds", activity."pauseTrackingBaselineSeconds";`, true).trim();
  if (finalState !== "1200|300|3|900") {
    throw new Error(`activity_timer_pause_concurrency_final_state_invalid:${finalState}`);
  }

  const pausedDeleteFailure = runSqlExpectingFailure(compose, env, `
SET ROLE cubby_runtime;
DELETE FROM "ActivityTimerPauseInterval" WHERE "id" = 'integrity-concurrency-pause-1';`);
  if (!pausedDeleteFailure.includes("permission denied")) {
    throw new Error("activity_timer_pause_partial_paused_delete_not_rejected");
  }

  runSql(compose, env, `
BEGIN;
SET ROLE cubby_runtime;
UPDATE "ActivityLog"
SET "timerState" = 'stopped', "pausedAt" = NULL, "pausedSeconds" = 1800,
  "endedAt" = '2026-01-02T02:00:00.000Z', "durationSeconds" = 5400, "updatedAt" = NOW()
WHERE "id" = 'integrity-concurrency-parent';
SELECT "closeActivityTimerPauseInterval"('integrity-concurrency-parent', '2026-01-02T01:05:00.000Z');
COMMIT;`);
  const stoppedUpdateFailure = runSqlExpectingFailure(compose, env, `
SET ROLE cubby_runtime;
UPDATE "ActivityTimerPauseInterval" SET "endedAt" = '2026-01-02T00:54:00.000Z'
WHERE "id" = 'integrity-concurrency-pause-2';`);
  if (!stoppedUpdateFailure.includes("permission denied")) {
    throw new Error("activity_timer_pause_partial_stopped_update_not_rejected");
  }
  runSql(compose, env, `DELETE FROM "ActivityLog" WHERE "id" = 'integrity-concurrency-parent';`);
}

async function runPauseIntervalMigrationRollbackCase(
  compose: string[],
  env: NodeJS.ProcessEnv,
  databaseUrl: string,
  prismaCli: string,
  targetMigrationPath: string
) {
  const schemaPath = resolve(targetMigrationPath, "..", "..", "schema.prisma");
  const migrationEnv = { ...env, DATABASE_URL: databaseUrl };
  runSql(compose, env, `
BEGIN;
SET session_replication_role = replica;
INSERT INTO "ActivityLog" (
  "id", "householdId", "babyId", "actorMemberId", "type", "occurredAt", "timezone", "source",
  "timerState", "startedAt", "endedAt", "durationSeconds", "pausedAt", "pausedSeconds", "createdAt", "updatedAt"
) VALUES (
  'integrity-invalid-paused-activity', 'integrity-household-a', 'integrity-baby-a', 'synthetic-member', 'sleep',
  '2026-01-01T01:00:00.000Z', 'UTC', 'manual', 'paused', '2026-01-01T01:00:00.000Z',
  NULL, NULL, '2026-01-01T00:59:00.000Z', 0, NOW(), NOW()
  ), (
  'integrity-invalid-future-running', 'integrity-household-a', 'integrity-baby-a', 'synthetic-member', 'sleep',
  '2099-01-01T01:00:00.000Z', 'UTC', 'manual', 'running', '2099-01-01T01:00:00.000Z',
  NULL, NULL, NULL, 600, NOW(), NOW()
  ), (
  'integrity-backfill-zero', 'integrity-household-a', 'integrity-baby-a', 'synthetic-member', 'sleep',
  '2026-01-01T02:00:00.000Z', 'UTC', 'manual', 'stopped', '2026-01-01T02:00:00.000Z',
  '2026-01-01T02:30:00.000Z', 1800, NULL, 0, NOW(), NOW()
  ), (
  'integrity-backfill-zero-mismatch', 'integrity-household-a', 'integrity-baby-a', 'synthetic-member', 'sleep',
  '2026-01-01T02:35:00.000Z', 'UTC', 'manual', 'stopped', '2026-01-01T02:35:00.000Z',
  '2026-01-01T02:55:00.000Z', 900, NULL, 0, NOW(), NOW()
  ), (
  'integrity-backfill-predecessor-rounding', 'integrity-household-a', 'integrity-baby-a', 'synthetic-member', 'sleep',
  '1970-01-01T00:00:00.600Z', 'UTC', 'manual', 'stopped', '1970-01-01T00:00:00.600Z',
  '1970-01-01T00:00:10.400Z', 10, NULL, 0, NOW(), NOW()
  ), (
  'integrity-backfill-running', 'integrity-household-a', 'integrity-baby-a', 'synthetic-member', 'sleep',
  '2026-01-01T03:00:00.000Z', 'UTC', 'manual', 'running', '2026-01-01T03:00:00.000Z',
  NULL, NULL, NULL, 600, NOW(), NOW()
  ), (
  'integrity-backfill-stopped', 'integrity-household-a', 'integrity-baby-a', 'synthetic-member', 'sleep',
  '2026-01-01T04:00:00.000Z', 'UTC', 'manual', 'stopped', '2026-01-01T04:00:00.000Z',
  '2026-01-01T05:00:00.000Z', 3000, NULL, 600, NOW(), NOW()
  ), (
  'integrity-backfill-paused', 'integrity-household-a', 'integrity-baby-a', 'synthetic-member', 'sleep',
  '2026-01-01T05:00:00.000Z', 'UTC', 'manual', 'paused', '2026-01-01T05:00:00.000Z',
  NULL, NULL, '2026-01-01T05:30:00.000Z', 600, NOW(), NOW()
);
SET session_replication_role = origin;
COMMIT;`);
  try {
    const refusal = runMigrationSqlExpectingFailure(compose, env, targetMigrationPath);
    if (!refusal.includes("activity_timer_pause_interval_preflight_failed")) {
      throw new Error(`activity_timer_pause_preflight_marker_missing\n${refusal.slice(-2000)}`);
    }
    assertPauseIntervalMigrationRolledBack(compose, env);
    runExpectingFailure(process.execPath, [prismaCli, "migrate", "deploy", "--schema", schemaPath], migrationEnv);
    assertPauseIntervalMigrationRolledBack(compose, env);
  } finally {
    runSql(compose, env, `DELETE FROM "ActivityLog"
      WHERE "id" IN ('integrity-invalid-paused-activity', 'integrity-invalid-future-running');`);
  }
  run(process.execPath, [prismaCli, "migrate", "resolve", "--rolled-back", pauseTargetMigration, "--schema", schemaPath], migrationEnv);
  run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", schemaPath], migrationEnv);
  const backfillState = runSql(compose, env, `
SELECT
  (SELECT "pauseTrackingStartedAt" = "startedAt" AND "pauseTrackingBaselineSeconds" = 0
    FROM "ActivityLog" WHERE "id" = 'integrity-backfill-zero') || '|' ||
  (SELECT "pauseTrackingStartedAt" IS NULL AND "pauseTrackingBaselineSeconds" IS NULL
    FROM "ActivityLog" WHERE "id" = 'integrity-backfill-zero-mismatch') || '|' ||
  (SELECT "pauseTrackingStartedAt" IS NULL AND "pauseTrackingBaselineSeconds" IS NULL
    FROM "ActivityLog" WHERE "id" = 'integrity-backfill-predecessor-rounding') || '|' ||
  (SELECT "pauseTrackingStartedAt" IS NOT NULL AND "pauseTrackingStartedAt" > "startedAt"
      AND "pauseTrackingBaselineSeconds" = 600
    FROM "ActivityLog" WHERE "id" = 'integrity-backfill-running') || '|' ||
  (SELECT "pauseTrackingStartedAt" IS NULL AND "pauseTrackingBaselineSeconds" IS NULL
    FROM "ActivityLog" WHERE "id" = 'integrity-backfill-stopped') || '|' ||
  (SELECT activity."pauseTrackingStartedAt" IS NOT NULL
      AND activity."pauseTrackingStartedAt" > activity."startedAt"
      AND activity."pauseTrackingBaselineSeconds" = 600
      AND pause."startedAt" = activity."pausedAt"
      AND pause."endedAt" IS NULL
    FROM "ActivityLog" activity
    JOIN "ActivityTimerPauseInterval" pause ON pause."activityId" = activity."id"
    WHERE activity."id" = 'integrity-backfill-paused');`, true).trim();
  if (backfillState !== "true|true|true|true|true|true") throw new Error(`activity_timer_pause_backfill_invalid:${backfillState}`);
  runPauseIntervalPostMigrationAcceptance(compose, env);
  await runPauseIntervalConcurrencyAcceptance(compose, env);
  runSql(compose, env, `DELETE FROM "ActivityLog" WHERE "id" LIKE 'integrity-backfill-%';`);
  process.stdout.write("INTEGRITY_ACTIVITY_TIMER_PAUSE_ROLLBACK_PASS\n");
}

export async function runIntegritySuiteAcceptanceRehearsal() {
  const project = `cubby_integrity_acceptance_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const temp = mkdtempSync(resolve(tmpdir(), "cubby-integrity-acceptance-"));
  const env: NodeJS.ProcessEnv = { ...process.env, COMPOSE_DISABLE_ENV_FILE: "true", CUBBY_INTEGRITY_ACCEPTANCE_PASSWORD: password, NODE_ENV: "test" };
  delete env.DATABASE_URL;
  delete env.DIRECT_URL;
  delete env.COMPOSE_FILE;
  delete env.COMPOSE_PROJECT_NAME;
  const compose = ["compose", "--project-name", project, "--file", composeFile];
  try {
    run("docker", [...compose, "up", "--detach", "--wait", "postgres"], env);
    const published = run("docker", [...compose, "port", "postgres", "5432"], env, true).trim();
    const port = published.match(/:(\d+)$/)?.[1];
    if (!port) throw new Error("integrity_suite_acceptance_port_invalid");
    const databaseUrl = `postgresql://cubby_integrity_acceptance:${password}@127.0.0.1:${port}/${database}?schema=public`;
    run("docker", [...compose, "exec", "--no-TTY", "postgres", ...createDisposableRuntimeRolesArgs(database, database)], env);
    cpSync(resolve(root, "prisma"), resolve(temp, "prisma"), { recursive: true });
    const prismaCli = resolve(root, "node_modules/prisma/build/index.js");
    const migrationsPath = resolve(temp, "prisma/migrations");
    const heldRoot = resolve(temp, "held-migrations");
    const heldMigrations = holdMigrationsFrom(migrationsPath, targetMigration, heldRoot);
    run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", resolve(temp, "prisma/schema.prisma")], { ...env, DATABASE_URL: databaseUrl });
    restoreHeldMigration(targetMigration, migrationsPath, heldRoot);
    const targetMigrationPath = resolve(migrationsPath, targetMigration);
    runTargetMigrationRollbackCases(compose, env, databaseUrl, prismaCli, targetMigrationPath);
    restoreHeldMigration(pauseTargetMigration, migrationsPath, heldRoot);
    await runPauseIntervalMigrationRollbackCase(
      compose,
      env,
      databaseUrl,
      prismaCli,
      resolve(migrationsPath, pauseTargetMigration)
    );
    for (const migration of heldMigrations.filter((name) => name > pauseTargetMigration)) {
      restoreHeldMigration(migration, migrationsPath, heldRoot);
    }
    run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", resolve(temp, "prisma/schema.prisma")], { ...env, DATABASE_URL: databaseUrl });
    // The migration cases' fixture households are deliberately incomplete (one has no owner at all),
    // and the checks below count globally, so they are removed before the suite measures anything.
    runSql(compose, env, `
DELETE FROM "Household" WHERE "id" IN ('integrity-household-a', 'integrity-household-b');
DELETE FROM "User" WHERE "id" = 'synthetic-user-a';`);
    const vitestCli = resolve(root, "node_modules/vitest/vitest.mjs");
    run(process.execPath, [vitestCli, "run", "--config", "scripts/integrity-suite.acceptance.vitest.config.ts"], { ...env, DATABASE_URL: databaseUrl });
  } finally {
    spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans"], { cwd: root, env, stdio: "ignore" });
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runIntegritySuiteAcceptanceRehearsal().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
