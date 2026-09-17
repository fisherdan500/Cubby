import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Disposable end-to-end reproduction of the class of runtime break that broke every activity save
// (and every other ordinary browser-operation mutation) live from 2026-08-24 to 2026-09-16: PR #74
// (requireFreshSession() applied to every mutation, not just the sensitive call sites) and PR #76
// (the row-lock helper needed UPDATE on "Session", which 20260824140000_global_security_foundation
// had revoked from cubby_runtime). Neither regression was caught by any existing test because unit
// tests exercise the service layer directly (bypassing the real restricted database role a running
// app connects as) and no existing acceptance rehearsal signs in and performs a mutation over HTTP.
// This boots the real app image against a disposable Postgres with the exact production role/grant
// topology (the app's own entrypoint provisioning scripts create it, same as docker-compose.yml),
// signs in for real, and saves an activity twice: immediately (a session-freshness regression alone
// would not have failed this) and again on a session artificially aged past
// SESSION_FRESH_AGE_SECONDS (this is what actually broke).
//
// The break hit every ordinary browser-operation mutation, not just activity.create, so the aged
// session then exercises one mutation per context helper that takes the session row lock:
// baby-scoped (timer stop), household-scoped (unit preferences, via the separately issued opening
// rather than the activity route's single call) and account-scoped (account appearance, which locks
// "User" as well as "Session"). Each asserts the row actually changed in the database, and the
// probe asserts cubby_runtime still holds no UPDATE grant on "Session" - the boundary whose
// violation the SECURITY DEFINER lock functions exist to avoid. See docs/DEVELOPMENT.md
// "Verification Commands".

const REHEARSAL_COMPOSE_FILE = "scripts/browser-operation-save-path.acceptance.compose.yml";
const REHEARSAL_DATABASE = "cubby_browser_operation_save_path";
const REHEARSAL_USER = "cubby_save_path_rehearsal";

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; capture?: boolean }) {
  const printable = [command, ...args].join(" ");
  console.log(`> ${printable}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    throw new Error(`browser_operation_save_path_rehearsal_command_failed (${result.status}): ${printable}${detail}`);
  }
  return String(result.stdout ?? "");
}

function parsePublishedPort(output: string, defaultPort: number) {
  const match = output.trim().match(/^127\.0\.0\.1:(\d{2,5})$/);
  if (!match) throw new Error("browser_operation_save_path_rehearsal_non_loopback_port");
  const port = Number(match[1]);
  if (port === defaultPort) throw new Error("browser_operation_save_path_rehearsal_default_port_reused");
  if (port < 1024 || port > 65_535) throw new Error("browser_operation_save_path_rehearsal_port_invalid");
  return port;
}

const prismaClientGenerator = `generator client {
  provider = "prisma-client-js"
}`;

function createIsolatedClientSchema(schema: string, clientOutputDirectory: string) {
  const normalized = schema.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  if (!normalized.startsWith(prismaClientGenerator)) throw new Error("browser_operation_save_path_rehearsal_client_generator_contract_invalid");
  const normalizedOutputDirectory = clientOutputDirectory.replaceAll("\\", "/");
  return normalized.replace(
    prismaClientGenerator,
    `generator client {\n  provider = "prisma-client-js"\n  output   = ${JSON.stringify(normalizedOutputDirectory)}\n}`
  );
}

function isolatedDockerEnvironment(secrets: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "COMPOSE_ENV_FILES"]) delete env[key];
  return { ...env, COMPOSE_DISABLE_ENV_FILE: "true", ...secrets };
}

function resourceCount(env: NodeJS.ProcessEnv, projectName: string, kind: "ps" | "volume" | "network") {
  const filter = `label=com.docker.compose.project=${projectName}`;
  const args = kind === "ps" ? ["ps", "--all", "--quiet", "--filter", filter] : [kind, "ls", "--quiet", "--filter", filter];
  return run("docker", args, { cwd: repositoryRoot, env, capture: true }).split(/\r?\n/).filter(Boolean).length;
}

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function runBrowserOperationSavePathRehearsal() {
  const projectName = `cubby_save_path_rehearsal_${randomBytes(4).toString("hex")}`;
  const composeArgs = ["compose", "--project-name", projectName, "--file", REHEARSAL_COMPOSE_FILE];
  const rehearsalPassword = randomBytes(24).toString("hex");
  const rehearsalAppPassword = randomBytes(24).toString("base64url");
  const secrets = {
    CUBBY_SAVE_PATH_REHEARSAL_PASSWORD: rehearsalPassword,
    CUBBY_SAVE_PATH_REHEARSAL_AUTH_SECRET: randomBytes(32).toString("hex"),
    CUBBY_SAVE_PATH_REHEARSAL_RUNTIME_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_SAVE_PATH_REHEARSAL_AUTH_DB_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_SAVE_PATH_REHEARSAL_EMAIL_DELIVERY_DB_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_SAVE_PATH_REHEARSAL_SECURITY_OPERATOR_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_SAVE_PATH_REHEARSAL_INVITATION_RUNTIME_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_SAVE_PATH_REHEARSAL_INVITATION_EXPIRY_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_SAVE_PATH_REHEARSAL_INVITATION_MAINTENANCE_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_SAVE_PATH_REHEARSAL_FRESH_AUTH_KEYRING: `1:${randomBytes(32).toString("base64url")}`,
    CUBBY_SAVE_PATH_REHEARSAL_EMAIL_DELIVERY_KEYRING: `1:${randomBytes(32).toString("base64url")}`,
    CUBBY_SAVE_PATH_REHEARSAL_THROTTLE_KEY: randomBytes(32).toString("base64url"),
    CUBBY_SAVE_PATH_REHEARSAL_SMTP_PASSWORD: randomBytes(24).toString("base64url")
  };
  const dockerEnv = isolatedDockerEnvironment(secrets);
  let composeAttempted = false;
  let passed = false;
  let migrationCwd: string | undefined;

  try {
    console.log(`Starting isolated disposable project ${projectName}.`);
    console.log("The rehearsal does not load .env, use the normal Compose file, or attach to the normal database volume/network.");

    composeAttempted = true;
    run("docker", [...composeArgs, "up", "--detach", "--wait", "postgres"], { cwd: repositoryRoot, env: dockerEnv });
    const publishedPostgres = run("docker", [...composeArgs, "port", "postgres", "5432"], { cwd: repositoryRoot, env: dockerEnv, capture: true });
    const postgresPort = parsePublishedPort(publishedPostgres, 5432);
    const migrationDatabaseUrl = `postgresql://${REHEARSAL_USER}:${encodeURIComponent(rehearsalPassword)}@127.0.0.1:${postgresPort}/${REHEARSAL_DATABASE}?schema=public`;

    migrationCwd = mkdtempSync(resolve(tmpdir(), "cubby-save-path-rehearsal-"));
    symlinkSync(resolve(repositoryRoot, "node_modules"), resolve(migrationCwd, "node_modules"), "junction");
    const isolatedPrismaDir = resolve(migrationCwd, "prisma");
    mkdirSync(isolatedPrismaDir, { recursive: true });
    const generatedClientDirectory = resolve(migrationCwd, "generated-prisma-client");
    const schema = resolve(isolatedPrismaDir, "schema.prisma");
    writeFileSync(schema, createIsolatedClientSchema(
      readFileSync(resolve(repositoryRoot, "prisma/schema.prisma"), "utf8"),
      generatedClientDirectory
    ));

    // Deliberately no host-side `prisma migrate deploy` here (unlike backup-recovery-rehearsal.ts,
    // which only ever replays a historical baseline predating role-dependent migrations). Migrations
    // from 20260824140000_global_security_foundation onward assume cubby_runtime/cubby_auth/etc.
    // already exist, and only the app's own entrypoint creates those roles (its `runtime_role` /
    // `invitation_runtime_roles` startup phases run before its `migration_apply` phase) - a host-side
    // migrate deploy against the bootstrap superuser alone fails partway through. `generate` only
    // needs the schema file, not a live connection or applied migrations, so it's safe to run now.
    const prismaCli = resolve(repositoryRoot, "node_modules/prisma/build/index.js");
    const vitestCli = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
    run(process.execPath, [prismaCli, "generate", "--schema", schema], {
      cwd: migrationCwd,
      env: { ...process.env, NODE_PATH: resolve(repositoryRoot, "node_modules"), PRISMA_GENERATE_SKIP_AUTOINSTALL: "true" }
    });

    run("docker", [...composeArgs, "up", "--detach", "--wait", "--build", "app"], { cwd: repositoryRoot, env: dockerEnv });
    const publishedApp = run("docker", [...composeArgs, "port", "app", "3000"], { cwd: repositoryRoot, env: dockerEnv, capture: true });
    const appPort = parsePublishedPort(publishedApp, 3000);

    // The app is healthy, so migrations and role provisioning are done; seed the fixture now,
    // through the bootstrap superuser connection (unaffected by role provisioning, since it's the
    // container's original POSTGRES_USER, not a role the app created).
    const handoffFile = resolve(migrationCwd, "save-path-handoff.json");
    const fixtureEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: migrationDatabaseUrl,
      REHEARSAL_HANDOFF_FILE: handoffFile,
      REHEARSAL_APP_PASSWORD: rehearsalAppPassword,
      REHEARSAL_PRISMA_CLIENT_PATH: generatedClientDirectory
    };
    run(process.execPath, [vitestCli, "run", "--config", "scripts/browser-operation-save-path-fixture.vitest.config.ts"], { cwd: repositoryRoot, env: fixtureEnv });

    run(process.execPath, [resolve(repositoryRoot, "scripts/browser-operation-save-path-probe.mjs")], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        REHEARSAL_APP_BASE_URL: `http://127.0.0.1:${appPort}`,
        REHEARSAL_HANDOFF_FILE: handoffFile,
        REHEARSAL_APP_PASSWORD: rehearsalAppPassword,
        REHEARSAL_PRISMA_CLIENT_PATH: generatedClientDirectory,
        REHEARSAL_MIGRATION_DATABASE_URL: migrationDatabaseUrl
      }
    });

    console.log("BROWSER_OPERATION_SAVE_PATH_ACCEPTANCE_PASS");
    passed = true;
  } finally {
    // Teardown destroys the containers, so a failure would otherwise leave only the probe's HTTP
    // status with no server-side cause - the app returns a generic server_error body by design.
    // Dump the app log before tearing down whenever the run did not pass.
    if (!passed && composeAttempted) {
      const appLog = spawnSync("docker", [...composeArgs, "logs", "--no-color", "--tail", "80", "app"], { cwd: repositoryRoot, env: dockerEnv, encoding: "utf8" });
      console.error("--- app log (last 80 lines, captured before teardown) ---");
      console.error(`${appLog.stdout ?? ""}${appLog.stderr ?? ""}`);
      console.error("--- end app log ---");
    }
    if (composeAttempted) {
      spawnSync("docker", [...composeArgs, "down", "--volumes", "--remove-orphans", "--rmi", "local"], { cwd: repositoryRoot, env: dockerEnv, stdio: "ignore" });
    }
    if (migrationCwd) rmSync(migrationCwd, { recursive: true, force: true });
    if (
      resourceCount(dockerEnv, projectName, "ps") ||
      resourceCount(dockerEnv, projectName, "volume") ||
      resourceCount(dockerEnv, projectName, "network") ||
      (migrationCwd !== undefined && existsSync(migrationCwd))
    ) {
      throw new Error("browser_operation_save_path_rehearsal_cleanup_incomplete");
    }
    console.log("BROWSER_OPERATION_SAVE_PATH_ACCEPTANCE_CLEANUP_PASS");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runBrowserOperationSavePathRehearsal();
