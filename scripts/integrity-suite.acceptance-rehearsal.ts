import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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
  ('integrity-event-b', 'integrity-household-b', 'Event B', NOW(), NOW(), NOW());`;

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

export function runIntegritySuiteAcceptanceRehearsal() {
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
    const targetMigrationPath = resolve(temp, "prisma/migrations", targetMigration);
    const heldMigrationPath = resolve(temp, targetMigration);
    renameSync(targetMigrationPath, heldMigrationPath);
    run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", resolve(temp, "prisma/schema.prisma")], { ...env, DATABASE_URL: databaseUrl });
    renameSync(heldMigrationPath, targetMigrationPath);
    runTargetMigrationRollbackCases(compose, env, databaseUrl, prismaCli, targetMigrationPath);
    // The migration cases' fixture households are deliberately incomplete (neither has an owner), and
    // the checks below count globally, so they are removed before the suite measures anything.
    runSql(compose, env, `DELETE FROM "Household" WHERE "id" IN ('integrity-household-a', 'integrity-household-b');`);
    const vitestCli = resolve(root, "node_modules/vitest/vitest.mjs");
    run(process.execPath, [vitestCli, "run", "--config", "scripts/integrity-suite.acceptance.vitest.config.ts"], { ...env, DATABASE_URL: databaseUrl });
  } finally {
    spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans"], { cwd: root, env, stdio: "ignore" });
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runIntegritySuiteAcceptanceRehearsal();
