import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CREATE_DISPOSABLE_RUNTIME_ROLES_SQL } from "./disposable-runtime-roles";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const composeFile = "scripts/browser-operation-pilot.acceptance.compose.yml";

/** Counted from the migrations themselves; a hardcoded total goes stale with the next migration. */
function migrationDirectoryCount() {
  return readdirSync(resolve(root, "prisma/migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .length;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, capture = false, code = "browser_operation_acceptance_command_failed") {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore"
  });
  if (result.error || result.status !== 0) {
    if (capture) {
      let diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      for (const [key, value] of Object.entries(env)) {
        if (value && (key.includes("PASSWORD") || key.includes("DATABASE_URL") || key.includes("SECRET"))) diagnostic = diagnostic.replaceAll(value, "[REDACTED]");
      }
      process.stderr.write(diagnostic.slice(-12_000));
    }
    throw new Error(code);
  }
  return String(result.stdout ?? "").trim();
}

function mustReject(command: string, args: string[], env: NodeJS.ProcessEnv, code: string) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: "ignore" });
  if (result.error || result.status === 0) throw new Error(code);
}

function acceptanceEnv(user: string, database: string, password: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COMPOSE_DISABLE_ENV_FILE: "true",
    NODE_ENV: "test",
    CUBBY_BROWSER_OPERATION_ACCEPTANCE_USER: user,
    CUBBY_BROWSER_OPERATION_ACCEPTANCE_DATABASE: database,
    CUBBY_BROWSER_OPERATION_ACCEPTANCE_PASSWORD: password
  };
  for (const key of ["DATABASE_URL", "DIRECT_URL", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"]) delete env[key];
  return env;
}

export function runBrowserOperationPilotAcceptance() {
  const suffix = randomBytes(8).toString("hex");
  const project = `cubby-p1-2b-pr53-acceptance-${suffix}`;
  const user = `browser_operation_${suffix}`;
  const database = `browser_operation_${suffix}`;
  const password = randomBytes(24).toString("base64url");
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "hermes-verify-browser-operation-"));
  const copiedPrisma = resolve(temporaryRoot, "prisma");
  const env = acceptanceEnv(user, database, password);
  const compose = ["compose", "--project-name", project, "--file", composeFile];
  const psql = (statement: string) => [
    ...compose,
    "exec", "-T", "postgres", "env", `PGPASSWORD=${password}`,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-U", user, "-d", database, "-c", statement
  ];
  const sql = (statement: string, expected?: string) => {
    const output = run("docker", psql(statement), env, true, "browser_operation_acceptance_sql_failed");
    if (expected !== undefined && output !== expected) throw new Error("browser_operation_acceptance_sql_assertion_failed");
  };
  const rejectSql = (statement: string, code: string) => mustReject("docker", psql(statement), env, code);
  const resourceCount = (kind: "ps" | "volume" | "network") => {
    const filter = `label=com.docker.compose.project=${project}`;
    const args = kind === "ps"
      ? ["ps", "--all", "--quiet", "--filter", filter]
      : [kind, "ls", "--quiet", "--filter", filter];
    return run("docker", args, env, true, "browser_operation_acceptance_cleanup_probe_failed").split(/\r?\n/).filter(Boolean).length;
  };

  cpSync(resolve(root, "prisma"), copiedPrisma, { recursive: true });
  try {
    run("docker", [...compose, "up", "--detach", "--wait", "postgres"], env, false, "browser_operation_acceptance_postgres_start_failed");
    const published = run("docker", [...compose, "port", "postgres", "5432"], env, true, "browser_operation_acceptance_port_probe_failed");
    if (!/^127\.0\.0\.1:\d+$/.test(published)) throw new Error("browser_operation_acceptance_loopback_port_invalid");
    const databaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${published}/${database}?schema=public`;
    const prismaCli = resolve(root, "node_modules/prisma/build/index.js");
    const vitestCli = resolve(root, "node_modules/vitest/vitest.mjs");
    // The migrations grant to the production role names, so those roles have to exist before deploy.
    sql(CREATE_DISPOSABLE_RUNTIME_ROLES_SQL);
    run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", resolve(copiedPrisma, "schema.prisma")], { ...env, DATABASE_URL: databaseUrl }, false, "browser_operation_acceptance_migrate_deploy_failed");
    run(process.execPath, [vitestCli, "run", "--config", "scripts/browser-operation-pilot.acceptance.vitest.config.ts"], { ...env, DATABASE_URL: databaseUrl }, true, "browser_operation_acceptance_dec407_service_failed");

    sql('SELECT COUNT(*) FROM "_prisma_migrations"', String(migrationDirectoryCount()));
    sql("SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('BrowserMutationOperation_terminal_outcome_check','BrowserMutationOperation_bindingId_fkey','BrowserOperationBinding_householdId_actorMemberId_fkey','BrowserOperationBinding_householdId_babyId_fkey')", "4");
    sql("INSERT INTO \"User\" (\"id\",\"name\",\"email\",\"emailVerified\",\"createdAt\",\"updatedAt\") VALUES ('u1','Synthetic User','u1@acceptance.invalid',true,NOW(),NOW()),('u2','Synthetic User Two','u2@acceptance.invalid',true,NOW(),NOW()); INSERT INTO \"Household\" (\"id\",\"name\",\"createdByUserId\",\"createdAt\",\"updatedAt\") VALUES ('h1','Synthetic Household','u1',NOW(),NOW()),('h2','Synthetic Household Two','u2',NOW(),NOW()); INSERT INTO \"HouseholdMember\" (\"id\",\"householdId\",\"userId\",\"role\",\"joinedAt\",\"createdAt\",\"updatedAt\") VALUES ('m1','h1','u1','owner',NOW(),NOW(),NOW()),('m2','h2','u2','owner',NOW(),NOW(),NOW()); INSERT INTO \"Baby\" (\"id\",\"householdId\",\"name\",\"timezone\",\"createdAt\",\"updatedAt\") VALUES ('b1','h1','Synthetic Baby','UTC',NOW(),NOW()),('b2','h2','Synthetic Baby Two','UTC',NOW(),NOW());");
    sql("INSERT INTO \"BrowserOperationBinding\" (\"id\",\"sessionId\",\"actorUserId\",\"actorMemberId\",\"householdId\",\"operationId\",\"operationKey\",\"openingFingerprint\",\"persistenceVersion\",\"targetKind\",\"babyId\",\"targetSnapshot\",\"protocolVersion\",\"state\",\"expiresAt\",\"issuedAt\",\"updatedAt\") VALUES ('bind1','session-retained','u1','m1','h1','bmo_0123456789abcdefghjkmnpqrs','calendar_event.create','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',2,'calendar','b1','{}','browser_v2','open',NOW() + INTERVAL '30 minutes',NOW(),NOW());");
    sql("INSERT INTO \"BrowserMutationOperation\" (\"bindingId\",\"householdId\",\"operationId\",\"operationKey\",\"actorUserId\",\"actorMemberId\",\"openingFingerprint\",\"intentFingerprint\",\"persistenceVersion\",\"targetKind\",\"babyId\",\"status\",\"outcomeVersion\",\"outcomeKind\",\"outcomeCode\",\"outcomeSnapshot\",\"terminalAt\",\"updatedAt\") VALUES ('bind1','h1','bmo_0123456789abcdefghjkmnpqrs','calendar_event.create','u1','m1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',2,'calendar','b1','completed',1,'created','calendar_event_created','{}',NOW(),NOW());");
    rejectSql("INSERT INTO \"BrowserOperationBinding\" (\"id\",\"sessionId\",\"actorUserId\",\"actorMemberId\",\"householdId\",\"operationId\",\"operationKey\",\"intentFingerprint\",\"expiresAt\",\"updatedAt\") VALUES ('bind2','session-retained','u1','m1','h1','bmo_0123456789abcdefghjkmnpqrs','dashboard.warning.dismiss','fp2',NOW(),NOW());", "browser_operation_acceptance_binding_unique_missing");
    rejectSql("INSERT INTO \"BrowserMutationOperation\" (\"bindingId\",\"householdId\",\"operationId\",\"operationKey\",\"actorUserId\",\"actorMemberId\",\"intentFingerprint\",\"status\",\"updatedAt\") VALUES ('bind1','h1','bmo_1123456789abcdefghjkmnpqrs','dashboard.warning.dismiss','u1','m1','fp2','pending',NOW());", "browser_operation_acceptance_binding_one_to_one_missing");
    rejectSql("INSERT INTO \"BrowserOperationBinding\" (\"id\",\"sessionId\",\"actorUserId\",\"actorMemberId\",\"householdId\",\"operationId\",\"operationKey\",\"intentFingerprint\",\"babyId\",\"expiresAt\",\"updatedAt\") VALUES ('bind3','session-retained','u1','m1','h1','bmo_2123456789abcdefghjkmnpqrs','calendar_event.create','fp3','b2',NOW(),NOW());", "browser_operation_acceptance_baby_scope_fk_missing");
    sql("INSERT INTO \"BrowserOperationBinding\" (\"id\",\"sessionId\",\"actorUserId\",\"actorMemberId\",\"householdId\",\"operationId\",\"operationKey\",\"intentFingerprint\",\"expiresAt\",\"updatedAt\") VALUES ('bind-terminal-check','session-retained','u1','m1','h1','bmo_4123456789abcdefghjkmnpqrs','dashboard.warning.dismiss','fp4',NOW(),NOW());");
    rejectSql("INSERT INTO \"BrowserMutationOperation\" (\"bindingId\",\"householdId\",\"operationId\",\"operationKey\",\"actorUserId\",\"actorMemberId\",\"intentFingerprint\",\"status\",\"updatedAt\") VALUES ('bind-terminal-check','h1','bmo_4123456789abcdefghjkmnpqrs','dashboard.warning.dismiss','u1','m1','fp4','completed',NOW());", "browser_operation_acceptance_terminal_outcome_check_missing");
    sql("INSERT INTO \"BrowserOperationBinding\" (\"id\",\"sessionId\",\"actorUserId\",\"actorMemberId\",\"householdId\",\"operationId\",\"operationKey\",\"intentFingerprint\",\"babyId\",\"expiresAt\",\"updatedAt\") VALUES ('legacy-adoption-check','session-retained','u1','m1','h1','bmo_6123456789abcdefghjkmnpqrs','calendar_event.create','legacy-fingerprint','b1',NOW(),NOW());");
    rejectSql("UPDATE \"BrowserOperationBinding\" SET \"persistenceVersion\"=2, \"protocolVersion\"='browser_v2', \"intentFingerprint\"=NULL, \"openingFingerprint\"='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', \"targetKind\"='calendar', \"targetSnapshot\"='{}' WHERE \"id\"='legacy-adoption-check'", "browser_operation_acceptance_legacy_v2_adoption_allowed");
    sql("INSERT INTO \"AccountOperationBinding\" (\"id\",\"sessionId\",\"userId\",\"operationId\",\"operationKey\",\"openingFingerprint\",\"persistenceVersion\",\"targetSnapshot\",\"protocolVersion\",\"expiresAt\",\"state\",\"issuedAt\",\"updatedAt\") VALUES ('account-terminal-check','session-retained','u1','bmo_5123456789abcdefghjkmnpqrs','account.appearance.update','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',2,'{}','browser_v2',NOW(),'open',NOW(),NOW());");
    rejectSql("INSERT INTO \"AccountMutationOperation\" (\"bindingId\",\"userId\",\"operationId\",\"operationKey\",\"openingFingerprint\",\"intentFingerprint\",\"persistenceVersion\",\"status\",\"terminalAt\",\"updatedAt\") VALUES ('account-terminal-check','u1','bmo_5123456789abcdefghjkmnpqrs','account.appearance.update','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',2,'completed',NOW(),NOW());", "account_operation_acceptance_terminal_outcome_check_missing");
    rejectSql("UPDATE \"BrowserMutationOperation\" SET \"outcomeCode\" = 'changed' WHERE \"bindingId\" = 'bind1'", "browser_operation_acceptance_terminal_update_allowed");
    rejectSql("DELETE FROM \"BrowserMutationOperation\" WHERE \"bindingId\" = 'bind1'", "browser_operation_acceptance_terminal_delete_allowed");
    sql("SELECT COUNT(*) FROM \"BrowserMutationOperation\" WHERE \"bindingId\" = 'bind1' AND \"outcomeCode\" = 'calendar_event_created'", "1");
    console.log("BROWSER_OPERATION_PILOT_ACCEPTANCE_PASS");
  } finally {
    spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans"], { cwd: root, env, stdio: "ignore" });
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (resourceCount("ps") || resourceCount("volume") || resourceCount("network") || existsSync(temporaryRoot)) {
      throw new Error("browser_operation_acceptance_cleanup_incomplete");
    }
    console.log("BROWSER_OPERATION_PILOT_ACCEPTANCE_CLEANUP_PASS");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runBrowserOperationPilotAcceptance();
