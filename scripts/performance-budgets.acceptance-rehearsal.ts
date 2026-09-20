import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Disposable performance release gate for DEC-PROD-225's workflow budgets over DEC-PROD-226's one- and
// five-year synthetic households. It boots the real app image against a disposable Postgres with the
// production role topology (the app's own entrypoint provisions the roles), seeds a deterministic
// dataset, signs in, and measures each workflow, failing when a p95 exceeds its budget.
//
// Nothing here touches the normal runtime: its own Compose project, database, volume and network, and
// no .env. Pass the dataset size as `--years=1` (default) or `--years=5`.

const REHEARSAL_COMPOSE_FILE = "scripts/performance-budgets.acceptance.compose.yml";
const REHEARSAL_DATABASE = "cubby_performance_budgets";
const REHEARSAL_USER = "cubby_performance_rehearsal";

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
    throw new Error(`performance_budgets_rehearsal_command_failed (${result.status}): ${printable}${detail}`);
  }
  return String(result.stdout ?? "");
}

function parsePublishedPort(output: string, defaultPort: number) {
  const match = output.trim().match(/^127\.0\.0\.1:(\d{2,5})$/);
  if (!match) throw new Error("performance_budgets_rehearsal_non_loopback_port");
  const port = Number(match[1]);
  if (port === defaultPort) throw new Error("performance_budgets_rehearsal_default_port_reused");
  if (port < 1024 || port > 65_535) throw new Error("performance_budgets_rehearsal_port_invalid");
  return port;
}

const prismaClientGenerator = `generator client {
  provider = "prisma-client-js"
}`;

function createIsolatedClientSchema(schema: string, clientOutputDirectory: string) {
  const normalized = schema.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  if (!normalized.startsWith(prismaClientGenerator)) throw new Error("performance_budgets_rehearsal_client_generator_contract_invalid");
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

export function parseDatasetYears(args: readonly string[]) {
  const value = args.find((arg) => arg.startsWith("--years="))?.slice("--years=".length) ?? "1";
  if (value !== "1" && value !== "5") throw new Error("performance_budgets_rehearsal_years_invalid");
  return Number(value) as 1 | 5;
}

/** `--browser` adds the input-acknowledgement stage, which needs a local Chrome. */
export function parseBrowserStage(args: readonly string[]) {
  return args.includes("--browser");
}

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function runPerformanceBudgetsRehearsal(years: 1 | 5 = 1, browserStage = false) {
  const projectName = `cubby_performance_rehearsal_${randomBytes(4).toString("hex")}`;
  const composeArgs = ["compose", "--project-name", projectName, "--file", REHEARSAL_COMPOSE_FILE];
  const rehearsalPassword = randomBytes(24).toString("hex");
  const rehearsalAppPassword = randomBytes(24).toString("base64url");
  const secrets = {
    CUBBY_PERFORMANCE_REHEARSAL_PASSWORD: rehearsalPassword,
    CUBBY_PERFORMANCE_REHEARSAL_AUTH_SECRET: randomBytes(32).toString("hex"),
    CUBBY_PERFORMANCE_REHEARSAL_RUNTIME_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_PERFORMANCE_REHEARSAL_AUTH_DB_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_PERFORMANCE_REHEARSAL_EMAIL_DELIVERY_DB_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_PERFORMANCE_REHEARSAL_SECURITY_OPERATOR_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_PERFORMANCE_REHEARSAL_INVITATION_RUNTIME_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_PERFORMANCE_REHEARSAL_INVITATION_EXPIRY_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_PERFORMANCE_REHEARSAL_INVITATION_MAINTENANCE_PASSWORD: randomBytes(24).toString("base64url"),
    CUBBY_PERFORMANCE_REHEARSAL_FRESH_AUTH_KEYRING: `1:${randomBytes(32).toString("base64url")}`,
    CUBBY_PERFORMANCE_REHEARSAL_EMAIL_DELIVERY_KEYRING: `1:${randomBytes(32).toString("base64url")}`,
    CUBBY_PERFORMANCE_REHEARSAL_THROTTLE_KEY: randomBytes(32).toString("base64url"),
    CUBBY_PERFORMANCE_REHEARSAL_SMTP_PASSWORD: randomBytes(24).toString("base64url")
  };
  const dockerEnv = isolatedDockerEnvironment(secrets);
  let composeAttempted = false;
  let passed = false;
  let migrationCwd: string | undefined;

  try {
    console.log(`Starting isolated disposable project ${projectName} with a ${years}-year dataset.`);
    console.log("The rehearsal does not load .env, use the normal Compose file, or attach to the normal database volume/network.");

    composeAttempted = true;
    run("docker", [...composeArgs, "up", "--detach", "--wait", "postgres"], { cwd: repositoryRoot, env: dockerEnv });
    const publishedPostgres = run("docker", [...composeArgs, "port", "postgres", "5432"], { cwd: repositoryRoot, env: dockerEnv, capture: true });
    const postgresPort = parsePublishedPort(publishedPostgres, 5432);
    const migrationDatabaseUrl = `postgresql://${REHEARSAL_USER}:${encodeURIComponent(rehearsalPassword)}@127.0.0.1:${postgresPort}/${REHEARSAL_DATABASE}?schema=public`;

    migrationCwd = mkdtempSync(resolve(tmpdir(), "cubby-performance-rehearsal-"));
    symlinkSync(resolve(repositoryRoot, "node_modules"), resolve(migrationCwd, "node_modules"), "junction");
    const isolatedPrismaDir = resolve(migrationCwd, "prisma");
    mkdirSync(isolatedPrismaDir, { recursive: true });
    const generatedClientDirectory = resolve(migrationCwd, "generated-prisma-client");
    const schema = resolve(isolatedPrismaDir, "schema.prisma");
    writeFileSync(schema, createIsolatedClientSchema(
      readFileSync(resolve(repositoryRoot, "prisma/schema.prisma"), "utf8"),
      generatedClientDirectory
    ));

    // Migrations are applied by the app's entrypoint (they depend on roles only it creates); generate
    // needs the schema file alone, so it is safe before the app starts.
    const prismaCli = resolve(repositoryRoot, "node_modules/prisma/build/index.js");
    const vitestCli = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
    run(process.execPath, [prismaCli, "generate", "--schema", schema], {
      cwd: migrationCwd,
      env: { ...process.env, NODE_PATH: resolve(repositoryRoot, "node_modules"), PRISMA_GENERATE_SKIP_AUTOINSTALL: "true" }
    });

    run("docker", [...composeArgs, "up", "--detach", "--wait", "--build", "app"], { cwd: repositoryRoot, env: dockerEnv });
    const publishedApp = run("docker", [...composeArgs, "port", "app", "3000"], { cwd: repositoryRoot, env: dockerEnv, capture: true });
    const appPort = parsePublishedPort(publishedApp, 3000);

    const handoffFile = resolve(migrationCwd, "performance-handoff.json");
    run(process.execPath, [vitestCli, "run", "--config", "scripts/performance-budgets-fixture.vitest.config.ts"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: migrationDatabaseUrl,
        REHEARSAL_HANDOFF_FILE: handoffFile,
        REHEARSAL_APP_PASSWORD: rehearsalAppPassword,
        REHEARSAL_DATASET_YEARS: String(years),
        REHEARSAL_PRISMA_CLIENT_PATH: generatedClientDirectory
      }
    });

    // Planner statistics decide whether the seeded history uses its indexes, and a bulk insert leaves
    // them stale. A real deployment's autovacuum would catch up; analyzing here keeps the measurement
    // about the queries rather than about a cold planner.
    run("docker", [...composeArgs, "exec", "-T", "postgres", "psql", "-U", REHEARSAL_USER, "-d", REHEARSAL_DATABASE, "-c", "VACUUM ANALYZE"], {
      cwd: repositoryRoot,
      env: dockerEnv
    });

    run(process.execPath, [resolve(repositoryRoot, "scripts/performance-budgets-probe.mjs")], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        REHEARSAL_APP_BASE_URL: `http://127.0.0.1:${appPort}`,
        REHEARSAL_HANDOFF_FILE: handoffFile,
        REHEARSAL_APP_PASSWORD: rehearsalAppPassword
      }
    });

    if (browserStage) {
      // The remaining budget is a client paint, so it needs a real browser driving real input events.
      run(process.execPath, [resolve(repositoryRoot, "scripts/performance-input-probe.mjs")], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          REHEARSAL_APP_BASE_URL: `http://127.0.0.1:${appPort}`,
          REHEARSAL_HANDOFF_FILE: handoffFile,
          REHEARSAL_APP_PASSWORD: rehearsalAppPassword
        }
      });
    }

    console.log(`PERFORMANCE_BUDGETS_ACCEPTANCE_PASS years=${years}${browserStage ? " browser=1" : ""}`);
    passed = true;
  } finally {
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
      throw new Error("performance_budgets_rehearsal_cleanup_incomplete");
    }
    console.log("PERFORMANCE_BUDGETS_ACCEPTANCE_CLEANUP_PASS");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPerformanceBudgetsRehearsal(parseDatasetYears(process.argv.slice(2)), parseBrowserStage(process.argv.slice(2)));
}
