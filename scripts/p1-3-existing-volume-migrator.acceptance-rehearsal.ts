import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workerRuntime = resolve(root, "..", "..", "..", "worker-runtime");
const migrationNames = readdirSync(resolve(root, "prisma", "migrations"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(resolve(root, "prisma", "migrations", entry.name, "migration.sql")))
  .map((entry) => entry.name)
  .sort();
const expectedMigrationCount = migrationNames.length;
const firstTargetMigration = "20260824140000_global_security_foundation";
const firstTargetIndex = migrationNames.indexOf(firstTargetMigration);
if (firstTargetIndex < 0) throw new Error("p1_3_migrator_bootstrap_target_missing");
const targetMigrationNames = migrationNames.slice(firstTargetIndex);
const targetMigrations = new Set(targetMigrationNames);
const expectedBaselineCount = firstTargetIndex;
const suffix = randomBytes(6).toString("hex");
const project = `cubby-p13-migrator-${suffix}`;
const temporaryRoot = mkdtempSync(resolve(workerRuntime, "cubby-p13-migrator-"));
const prismaRoot = resolve(temporaryRoot, "prisma");
const composeFile = resolve(temporaryRoot, "compose.yml");
const password = () => randomBytes(24).toString("base64url");
const key = () => randomBytes(32).toString("base64url");
const legacyPassword = password();
const migratorPassword = password();
const runtimePassword = password();
const authPassword = password();
const deliveryPassword = password();
const operatorPassword = password();
const attestationKey = key();
const deliveryKey = key();
const throttleKey = key();
let phase = "setup";

const compose = ["compose", "--project-name", project, "--file", composeFile];
const environment = {
  ...process.env,
  CUBBY_MIGRATOR_DB_PASSWORD: legacyPassword,
  P1_3_POSTGRES_USER: "cubby",
  P1_3_RUNNER_IMAGE: "",
  P1_3_PRISMA_DIR: prismaRoot.replaceAll("\\", "/")
};

function run(args: string[], input?: string, timeout = 300_000) {
  const result = spawnSync("docker", args, { cwd: root, env: environment, input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    if (phase === "transition") {
      const safe = String(result.stderr ?? "").trim().split(/\r?\n/).at(-1) ?? "transition_error_unavailable";
      process.stderr.write(`P1_3_MIGRATOR_BOOTSTRAP_TRANSITION_ERROR=${safe}\n`);
    }
    throw new Error(`p1_3_migrator_bootstrap_${phase}_failed`);
  }
  return String(result.stdout ?? "").trim();
}

function databaseUrl(user: string, secret: string) {
  return `postgresql://${user}:${secret}@postgres:5432/cubby?schema=public`;
}

function runner(scriptAndArgs: string[], vars: Record<string,string>, timeout = 300_000) {
  const args = [...compose, "run", "--rm", "--no-deps"];
  for (const [name,value] of Object.entries(vars)) args.push("-e", `${name}=${value}`);
  args.push("runner", ...scriptAndArgs);
  return run(args, undefined, timeout);
}

function psql(user: string, statement: string, vars: string[] = []) {
  return run([...compose, "exec", "-T", "postgres", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", ...vars.flatMap((value) => ["-v", value]), "-U", user, "-d", "cubby"], statement);
}

function bootstrapResult() {
  return spawnSync("docker", [...compose, "exec", "-T", "postgres", "sh", "-lc", "test \"$POSTGRES_USER\" = cubby_migrator && case \"$POSTGRES_PASSWORD\" in ''|*[!A-Za-z0-9_-]*) exit 64;; esac && export PGOPTIONS=\"-c cubby.bootstrap_migrator_password=$POSTGRES_PASSWORD\" && exec psql -X -v ON_ERROR_STOP=1 -At -U cubby -d \"$POSTGRES_DB\""], {
    cwd: root,
    env: environment,
    input: readFileSync(resolve(root, "scripts", "bootstrap-existing-migrator-role.sql"), "utf8"),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 300_000,
    maxBuffer: 1024 * 1024
  });
}

function copyBaseline() {
  mkdirSync(prismaRoot, { recursive: true });
  cpSync(resolve(root, "prisma", "schema.prisma"), resolve(prismaRoot, "schema.prisma"));
  const destination = resolve(prismaRoot, "migrations");
  mkdirSync(destination);
  for (const name of readdirSync(resolve(root, "prisma", "migrations"))) {
    if (!targetMigrations.has(name)) cpSync(resolve(root, "prisma", "migrations", name), resolve(destination, name), { recursive: true });
  }
}

function addTargetMigrations() {
  for (const name of targetMigrationNames) cpSync(resolve(root, "prisma", "migrations", name), resolve(prismaRoot, "migrations", name), { recursive: true });
}

try {
  phase = "prepare";
  copyBaseline();
  environment.P1_3_RUNNER_IMAGE = run(["image", "inspect", "cubby-app", "--format", "{{.Id}}"]);
  writeFileSync(composeFile, `services:\n  postgres:\n    image: postgres:16-alpine\n    environment:\n      POSTGRES_DB: cubby\n      POSTGRES_USER: \${P1_3_POSTGRES_USER}\n      POSTGRES_PASSWORD: \${CUBBY_MIGRATOR_DB_PASSWORD}\n    volumes:\n      - data:/var/lib/postgresql/data\n    labels:\n      cubby.acceptance: p1-3-migrator-bootstrap\n  runner:\n    image: \${P1_3_RUNNER_IMAGE}\n    entrypoint: [\"node\"]\n    profiles: [\"runner\"]\n    volumes:\n      - \${P1_3_PRISMA_DIR}:/work/prisma:ro\n    labels:\n      cubby.acceptance: p1-3-migrator-bootstrap\nvolumes:\n  data:\n    labels:\n      cubby.acceptance: p1-3-migrator-bootstrap\n`);

  phase = "resource_start";
  run([...compose, "up", "-d", "postgres"]);
  let ready = false;
  for (let attempt=0;attempt<120&&!ready;attempt+=1) {
    const result = spawnSync("docker", [...compose, "exec", "-T", "postgres", "pg_isready", "-U", "cubby", "-d", "cubby"], { cwd: root, env: environment, stdio: "ignore" });
    ready = result.status === 0;
    if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);
  }
  if (!ready) throw new Error("p1_3_migrator_bootstrap_postgres_not_ready");

  phase = "baseline";
  runner(["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "/work/prisma/schema.prisma"], { DATABASE_URL: databaseUrl("cubby", legacyPassword) }, 600_000);
  if (psql("cubby", `SELECT COUNT(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL;`) !== String(expectedBaselineCount)) throw new Error("p1_3_migrator_bootstrap_baseline_count_invalid");
  console.log("P1_3_MIGRATOR_BOOTSTRAP_BASELINE_PASS");

  phase = "merged_environment_recreation";
  environment.P1_3_POSTGRES_USER = "cubby_migrator";
  environment.CUBBY_MIGRATOR_DB_PASSWORD = migratorPassword;
  run([...compose, "up", "-d", "--force-recreate", "postgres"]);
  let recreatedReady = false;
  for (let attempt=0;attempt<120&&!recreatedReady;attempt+=1) {
    const result = spawnSync("docker", [...compose, "exec", "-T", "postgres", "pg_isready", "-U", "cubby", "-d", "cubby"], { cwd: root, env: environment, stdio: "ignore" });
    recreatedReady = result.status === 0;
    if (!recreatedReady) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);
  }
  if (!recreatedReady) throw new Error("p1_3_migrator_bootstrap_recreated_postgres_not_ready");

  phase = "partial_target_rejection";
  psql("cubby", `INSERT INTO "_prisma_migrations" ("id","checksum","migration_name","started_at","applied_steps_count") VALUES ('00000000-0000-4000-8000-000000000001','synthetic','20260824140000_global_security_foundation',CURRENT_TIMESTAMP,0);`);
  const rejected = bootstrapResult();
  if (rejected.status === 0 || !String(rejected.stderr ?? "").includes("legacy_migrator_bootstrap_target_migration_present")) throw new Error("p1_3_migrator_bootstrap_partial_target_not_rejected");
  if (psql("cubby", `SELECT COUNT(*) FROM pg_roles WHERE rolname='cubby_migrator';`) !== "0") throw new Error("p1_3_migrator_bootstrap_partial_target_mutated_role");
  psql("cubby", `DELETE FROM "_prisma_migrations" WHERE "id"='00000000-0000-4000-8000-000000000001';`);
  console.log("P1_3_MIGRATOR_BOOTSTRAP_PARTIAL_TARGET_REJECTED_PASS");

  phase = "transition";
  const transition = bootstrapResult();
  if (transition.error || transition.status !== 0) throw new Error("p1_3_migrator_bootstrap_transition_failed");
  const ownership = psql("cubby_migrator", `SELECT (SELECT datdba='cubby_migrator'::regrole FROM pg_database WHERE datname='cubby')::int || '|' || (SELECT nspowner='cubby_migrator'::regrole FROM pg_namespace WHERE nspname='public')::int || '|' || (SELECT rolsuper::int || ':' || rolcanlogin::int FROM pg_roles WHERE rolname='cubby');`);
  if (ownership !== "1|1|1:0") throw new Error("p1_3_migrator_bootstrap_ownership_invalid");
  console.log("P1_3_MIGRATOR_BOOTSTRAP_TRANSITION_PASS");

  phase = "restricted_roles";
  runner(["provision-security-runtime-role.mjs"], {
    DATABASE_URL: databaseUrl("cubby_migrator",migratorPassword),
    CUBBY_RUNTIME_DATABASE_URL: databaseUrl("cubby_runtime",runtimePassword),
    CUBBY_AUTH_DATABASE_URL: databaseUrl("cubby_auth",authPassword),
    CUBBY_EMAIL_DELIVERY_DATABASE_URL: databaseUrl("cubby_email_delivery",deliveryPassword),
    CUBBY_SECURITY_OPERATOR_DB_PASSWORD: operatorPassword
  });
  console.log("P1_3_MIGRATOR_BOOTSTRAP_RESTRICTED_ROLES_PASS");

  phase = "target_migrations";
  addTargetMigrations();
  runner(["node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "/work/prisma/schema.prisma"], { DATABASE_URL: databaseUrl("cubby_migrator",migratorPassword) }, 600_000);

  phase = "key_provision";
  const owner = { DATABASE_URL: databaseUrl("cubby_migrator",migratorPassword) };
  runner(["provision-fresh-auth-attestation-keys.mjs"], { ...owner, CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${attestationKey}`, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1" });
  runner(["provision-email-delivery-keys.mjs"], { ...owner, CUBBY_EMAIL_DELIVERY_KEYRING: `1:${deliveryKey}`, CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "1" });
  runner(["provision-global-security-throttle-key.mjs"], { ...owner, CUBBY_THROTTLE_KEY: throttleKey });

  phase = "verification";
  const result = psql("cubby_migrator", `SELECT (SELECT COUNT(*) FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL) || '|' || (SELECT COUNT(*) FROM "_prisma_migrations" WHERE "finished_at" IS NULL OR "rolled_back_at" IS NOT NULL) || '|' || (SELECT COUNT(*) FROM pg_roles WHERE rolname IN ('cubby_runtime','cubby_auth','cubby_email_delivery','cubby_security_operator') AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls) || '|' || (SELECT COUNT(*) FROM pg_auth_members membership JOIN pg_roles member ON member.oid=membership.member WHERE member.rolname IN ('cubby_runtime','cubby_auth','cubby_email_delivery','cubby_security_operator')) || '|' || (SELECT COUNT(*) FROM pg_class WHERE relowner IN ('cubby_runtime'::regrole,'cubby_auth'::regrole,'cubby_email_delivery'::regrole,'cubby_security_operator'::regrole)) || '|' || (SELECT COUNT(*) FROM "FreshAuthAttestationKey") || '|' || (SELECT COUNT(*) FROM "EmailDeliveryEncryptionKey") || '|' || (SELECT COUNT(*) FROM "GlobalSecurityThrottleKey") || '|' || has_table_privilege('cubby_runtime', '"ActivityTimerPauseInterval"', 'SELECT') || '|' || has_table_privilege('cubby_runtime', '"ActivityTimerPauseInterval"', 'INSERT') || '|' || has_table_privilege('cubby_runtime', '"ActivityTimerPauseInterval"', 'UPDATE') || '|' || has_table_privilege('cubby_runtime', '"ActivityTimerPauseInterval"', 'DELETE') || '|' || has_function_privilege('cubby_runtime', '"closeActivityTimerPauseInterval"(text,timestamp without time zone)', 'EXECUTE');`);
  if (result !== `${expectedMigrationCount}|0|4|0|0|1|1|1|t|t|f|f|t`) throw new Error("p1_3_migrator_bootstrap_final_verification_invalid");
  console.log("P1_3_MIGRATOR_BOOTSTRAP_MIGRATIONS_KEYS_PASS");
  console.log("P1_3_MIGRATOR_BOOTSTRAP_ACCEPTANCE_PASS");
} finally {
  phase = "cleanup";
  spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans"], { cwd: root, env: environment, stdio: "ignore", timeout: 120_000 });
  rmSync(temporaryRoot, { recursive: true, force: true });
  const containers = spawnSync("docker", ["ps", "-a", "--quiet", "--filter", `label=com.docker.compose.project=${project}`], { encoding: "utf8" }).stdout.trim();
  const volumes = spawnSync("docker", ["volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`], { encoding: "utf8" }).stdout.trim();
  const networks = spawnSync("docker", ["network", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`], { encoding: "utf8" }).stdout.trim();
  if (containers || volumes || networks || existsSync(temporaryRoot)) {
    console.error("P1_3_MIGRATOR_BOOTSTRAP_ACCEPTANCE_CLEANUP_FAIL");
    process.exitCode = 9;
  } else {
    console.log("P1_3_MIGRATOR_BOOTSTRAP_ACCEPTANCE_CLEANUP_PASS");
  }
}
