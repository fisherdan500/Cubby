import { randomBytes } from "node:crypto";
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REHEARSAL_COMPOSE_FILE = "scripts/backup-recovery-rehearsal.compose.yml";
const REHEARSAL_DATABASE = "cubby_backup_rehearsal";
const REHEARSAL_USER = "cubby_rehearsal";
export const UPDATE_REHEARSAL_BASELINE = "20260714220000_reversible_baby_inactivity";

export function selectMigrationPrefix(migrations: string[]) {
  if (migrations.length === 0 || migrations.some((migration) => migration.length === 0)) {
    throw new Error("update_rehearsal_migration_order_invalid");
  }
  if (new Set(migrations).size !== migrations.length) {
    throw new Error("update_rehearsal_migration_duplicate");
  }
  const ordered = [...migrations].sort((left, right) => left.localeCompare(right));
  if (ordered.some((migration, index) => migration !== migrations[index])) {
    throw new Error("update_rehearsal_migration_order_invalid");
  }
  const baselineMatches = migrations.filter((migration) => migration === UPDATE_REHEARSAL_BASELINE);
  if (baselineMatches.length !== 1) {
    throw new Error("update_rehearsal_baseline_missing");
  }
  return migrations.slice(0, migrations.indexOf(UPDATE_REHEARSAL_BASELINE) + 1);
}

export function assertMigrationFailureContract(observation: {
  error: unknown;
  status: number | null;
  output: string;
  containerState: {
    status: string;
    exitCode: number;
    healthStatus: string;
    healthExitCodes: number[];
  };
}) {
  if (
    observation.error ||
    observation.status === null ||
    observation.status === 0 ||
    !observation.output.includes("cubby_startup phase=migration status=failed") ||
    observation.output.includes("cubby_startup phase=server status=starting") ||
    observation.containerState.status !== "exited" ||
    observation.containerState.exitCode === 0 ||
    !["starting", "unhealthy"].includes(observation.containerState.healthStatus) ||
    observation.containerState.healthExitCodes.length === 0 ||
    observation.containerState.healthExitCodes.some((exitCode) => exitCode === 0)
  ) {
    throw new Error("update_rehearsal_migration_failure_contract_invalid");
  }
}

export function cleanupResultFailed(result: { error?: unknown; status: number | null }) {
  return Boolean(result.error) || result.status !== 0;
}

export function cleanupTemporaryPaths(
  paths: string[],
  remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true })
) {
  let failed = false;
  for (const path of paths) {
    try {
      remove(path);
    } catch {
      failed = true;
    }
  }
  return failed;
}

type DisposableConfig = {
  projectName: string;
  databaseName: string;
  databaseUser: string;
  composeFile: string;
  backupDirectory: string;
};

export function assertDisposableRehearsalConfig(config: DisposableConfig) {
  const normalizedCompose = config.composeFile.replaceAll("\\", "/");
  const normalizedBackupDirectory = config.backupDirectory.replaceAll("\\", "/");
  if (
    !/^cubby_backup_rehearsal_\d{8}_[a-f0-9]{8}$/.test(config.projectName) ||
    config.databaseName !== REHEARSAL_DATABASE ||
    config.databaseUser !== REHEARSAL_USER ||
    normalizedCompose !== REHEARSAL_COMPOSE_FILE ||
    normalizedCompose.includes(".env") ||
    !normalizedBackupDirectory.includes("/cubby-backup-rehearsal-files-")
  ) {
    throw new Error("refusing_non_disposable_backup_rehearsal");
  }
}

export function parsePublishedPostgresPort(output: string) {
  const match = output.trim().match(/^127\.0\.0\.1:(\d{2,5})$/);
  if (!match) throw new Error("refusing_non_loopback_backup_rehearsal");
  const port = Number(match[1]);
  if (port === 5432) throw new Error("refusing_default_postgres_port");
  if (port < 1024 || port > 65_535) throw new Error("invalid_backup_rehearsal_port");
  return port;
}

export function parsePublishedAppPort(output: string) {
  const match = output.trim().match(/^127\.0\.0\.1:(\d{2,5})$/);
  if (!match) throw new Error("refusing_non_loopback_backup_rehearsal");
  const port = Number(match[1]);
  if (port === 3000) throw new Error("refusing_default_app_port");
  if (port < 1024 || port > 65_535) throw new Error("invalid_backup_rehearsal_port");
  return port;
}

export function parseImmutableImageId(output: string) {
  const imageId = output.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new Error("rehearsal_app_image_id_invalid");
  }
  return imageId;
}

export function createDisposableDatabaseUrl(port: number, password: string) {
  return `postgresql://${REHEARSAL_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${REHEARSAL_DATABASE}?schema=public`;
}

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
    throw new Error(`backup_rehearsal_command_failed (${result.status}): ${printable}${detail}`);
  }
  return String(result.stdout ?? "");
}

function isolatedEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "DATABASE_URL",
    "DIRECT_URL",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "COMPOSE_FILE",
    "COMPOSE_PROJECT_NAME"
  ]) {
    delete env[key];
  }
  return { ...env, NODE_ENV: "test", DATABASE_URL: databaseUrl };
}

function isolatedDockerEnvironment(
  password: string,
  authSecret: string,
  backupDirectory: string
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "COMPOSE_ENV_FILES"]) {
    delete env[key];
  }
  return {
    ...env,
    COMPOSE_DISABLE_ENV_FILE: "true",
    CUBBY_BACKUP_REHEARSAL_PASSWORD: password,
    CUBBY_BACKUP_REHEARSAL_AUTH_SECRET: authSecret,
    CUBBY_BACKUP_REHEARSAL_DIRECTORY: backupDirectory
  };
}

export function runBackupRecoveryRehearsal() {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const projectName = `cubby_backup_rehearsal_${date}_${randomBytes(4).toString("hex")}`;
  const composeArgs = ["compose", "--project-name", projectName, "--file", REHEARSAL_COMPOSE_FILE];
  const rehearsalPassword = randomBytes(24).toString("hex");
  const rehearsalAuthSecret = randomBytes(32).toString("hex");
  const rehearsalAppPassword = randomBytes(24).toString("base64url");
  const failureContainer = `${projectName}_migration_failure`;
  const config: DisposableConfig = {
    projectName,
    databaseName: REHEARSAL_DATABASE,
    databaseUser: REHEARSAL_USER,
    composeFile: REHEARSAL_COMPOSE_FILE,
    backupDirectory: mkdtempSync(resolve(tmpdir(), "cubby-backup-rehearsal-files-"))
  };
  let dockerEnv: ReturnType<typeof isolatedDockerEnvironment> | undefined;
  let migrationCwd: string | undefined;
  let composeAttempted = false;
  let failureContainerAttempted = false;
  let teardownFailed = false;
  let rehearsalFailure: unknown;

  try {
    assertDisposableRehearsalConfig(config);
    dockerEnv = isolatedDockerEnvironment(rehearsalPassword, rehearsalAuthSecret, config.backupDirectory);
    migrationCwd = mkdtempSync(resolve(tmpdir(), "cubby-backup-rehearsal-"));
    const isolatedPrismaDir = resolve(migrationCwd, "prisma");
    const handoffFile = resolve(migrationCwd, "app-probe-handoff.json");

    console.log(`Starting isolated disposable project ${config.projectName}.`);
    console.log("The rehearsal does not load .env, use the normal Compose file, or attach to the normal database volume.");

    composeAttempted = true;
    run("docker", [...composeArgs, "up", "--detach", "--wait", "postgres"], {
      cwd: repositoryRoot,
      env: dockerEnv
    });
    const published = run("docker", [...composeArgs, "port", "postgres", "5432"], {
      cwd: repositoryRoot,
      env: dockerEnv,
      capture: true
    });
    const port = parsePublishedPostgresPort(published);
    const databaseUrl = createDisposableDatabaseUrl(port, rehearsalPassword);
    const env = {
      ...isolatedEnvironment(databaseUrl),
      AUTOMATED_BACKUPS_ENABLED: "true",
      AUTOMATED_BACKUP_DIRECTORY: config.backupDirectory,
      AUTOMATED_BACKUP_RETENTION_COUNT: "2",
      REHEARSAL_HANDOFF_FILE: handoffFile,
      REHEARSAL_APP_PASSWORD: rehearsalAppPassword
    };

    const prismaCli = resolve(repositoryRoot, "node_modules/prisma/build/index.js");
    const committedMigrations = readdirSync(resolve(repositoryRoot, "prisma/migrations"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    const baselineMigrations = selectMigrationPrefix(committedMigrations);
    mkdirSync(resolve(isolatedPrismaDir, "migrations"), { recursive: true });
    const schema = resolve(isolatedPrismaDir, "schema.prisma");
    copyFileSync(resolve(repositoryRoot, "prisma/schema.prisma"), schema);
    copyFileSync(
      resolve(repositoryRoot, "prisma/migrations/migration_lock.toml"),
      resolve(isolatedPrismaDir, "migrations/migration_lock.toml")
    );
    for (const migration of baselineMigrations) {
      cpSync(
        resolve(repositoryRoot, "prisma/migrations", migration),
        resolve(isolatedPrismaDir, "migrations", migration),
        { recursive: true }
      );
    }
    run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", schema], { cwd: migrationCwd, env });
    const vitestCli = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
    const esbuildCli = resolve(repositoryRoot, "node_modules/esbuild/bin/esbuild");
    run(process.execPath, [
      esbuildCli,
      "scripts/platform-owner.ts",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node22",
      "--packages=external",
      "--outfile=dist/platform-owner.mjs"
    ], { cwd: repositoryRoot, env });
    run(process.execPath, [vitestCli, "run", "--config", "scripts/update-baseline-fixture.vitest.config.ts"], {
      cwd: repositoryRoot,
      env: { ...env, UPDATE_BASELINE_PHASE: "seed" }
    });

    // The image entrypoint, not the host, applies the migrations after the fixed baseline.
    run("docker", [...composeArgs, "up", "--detach", "--wait", "--build", "app"], {
      cwd: repositoryRoot,
      env: dockerEnv
    });
    run(process.execPath, [vitestCli, "run", "--config", "scripts/update-baseline-fixture.vitest.config.ts"], {
      cwd: repositoryRoot,
      env: {
        ...env,
        UPDATE_BASELINE_PHASE: "verify",
        UPDATE_COMMITTED_MIGRATIONS: committedMigrations.join(",")
      }
    });
    run(
      process.execPath,
      [vitestCli, "run", "--config", "scripts/backup-recovery-rehearsal.vitest.config.ts"],
      { cwd: repositoryRoot, env }
    );

    const publishedApp = run("docker", [...composeArgs, "port", "app", "3000"], {
      cwd: repositoryRoot,
      env: dockerEnv,
      capture: true
    });
    const appPort = parsePublishedAppPort(publishedApp);
    const probeEnv = {
      ...isolatedEnvironment(databaseUrl),
      REHEARSAL_APP_BASE_URL: `http://127.0.0.1:${appPort}`,
      REHEARSAL_HANDOFF_FILE: handoffFile,
      REHEARSAL_APP_PASSWORD: rehearsalAppPassword
    };
    const probeScript = resolve(repositoryRoot, "scripts/backup-container-replacement-probe.mjs");
    run(process.execPath, [probeScript], { cwd: repositoryRoot, env: probeEnv });

    const firstAppContainer = run("docker", [...composeArgs, "ps", "--quiet", "app"], {
      cwd: repositoryRoot,
      env: dockerEnv,
      capture: true
    }).trim();
    if (!/^[a-f0-9]{12,64}$/.test(firstAppContainer)) throw new Error("rehearsal_app_container_id_invalid");
    run("docker", [...composeArgs, "up", "--detach", "--wait", "--force-recreate", "--no-deps", "app"], {
      cwd: repositoryRoot,
      env: dockerEnv
    });
    const replacementAppContainer = run("docker", [...composeArgs, "ps", "--quiet", "app"], {
      cwd: repositoryRoot,
      env: dockerEnv,
      capture: true
    }).trim();
    if (!/^[a-f0-9]{12,64}$/.test(replacementAppContainer) || replacementAppContainer === firstAppContainer) {
      throw new Error("rehearsal_app_container_not_replaced");
    }
    const replacementPublishedApp = run("docker", [...composeArgs, "port", "app", "3000"], {
      cwd: repositoryRoot,
      env: dockerEnv,
      capture: true
    });
    const replacementAppPort = parsePublishedAppPort(replacementPublishedApp);
    run(process.execPath, [probeScript], {
      cwd: repositoryRoot,
      env: { ...probeEnv, REHEARSAL_APP_BASE_URL: `http://127.0.0.1:${replacementAppPort}` }
    });

    const appImage = parseImmutableImageId(run("docker", [
      "inspect",
      "--format",
      "{{.Image}}",
      replacementAppContainer
    ], {
      cwd: repositoryRoot,
      env: dockerEnv,
      capture: true
    }));
    failureContainerAttempted = true;
    const failedStartup = spawnSync("docker", [
      "run", "--name", failureContainer, "--network", "none",
      "--health-cmd", "node -e \"fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
      "--health-interval", "1s",
      "--health-timeout", "1s",
      "--health-retries", "1",
      "--health-start-period", "0s",
      "--entrypoint", "/bin/sh",
      "--env", `DATABASE_URL=postgresql://cubby_rehearsal:${rehearsalPassword}@127.0.0.1:1/cubby_backup_rehearsal`,
      "--env", `BETTER_AUTH_SECRET=${rehearsalAuthSecret}`,
      "--env", "BETTER_AUTH_URL=http://127.0.0.1:3000",
      appImage, "-c", "sleep 2; exec /usr/local/bin/cubby-entrypoint"
    ], { cwd: repositoryRoot, env: dockerEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const failedOutput = `${failedStartup.stdout ?? ""}${failedStartup.stderr ?? ""}`;
    const failedState = JSON.parse(run("docker", ["inspect", "--format", "{{json .State}}", failureContainer], {
      cwd: repositoryRoot, env: dockerEnv, capture: true
    })) as {
      Status?: unknown;
      ExitCode?: unknown;
      Health?: { Status?: unknown; Log?: Array<{ ExitCode?: unknown }> };
    };
    assertMigrationFailureContract({
      error: failedStartup.error,
      status: failedStartup.status,
      output: failedOutput,
      containerState: {
        status: typeof failedState.Status === "string" ? failedState.Status : "invalid",
        exitCode: typeof failedState.ExitCode === "number" ? failedState.ExitCode : 0,
        healthStatus: typeof failedState.Health?.Status === "string" ? failedState.Health.Status : "none",
        healthExitCodes: Array.isArray(failedState.Health?.Log)
          ? failedState.Health.Log.map((entry) => typeof entry.ExitCode === "number" ? entry.ExitCode : 0)
          : []
      }
    });
  } catch (error) {
    rehearsalFailure = error;
  } finally {
    if (failureContainerAttempted) {
      const removal = spawnSync("docker", ["rm", "--force", failureContainer], {
        cwd: repositoryRoot, env: dockerEnv, encoding: "utf8", stdio: "ignore"
      });
      if (cleanupResultFailed(removal)) {
        teardownFailed = true;
        console.error(`Disposable container cleanup failed for ${config.projectName}.`);
      }
    }
    if (composeAttempted) {
      const teardown = spawnSync("docker", [...composeArgs, "down", "--volumes", "--remove-orphans", "--rmi", "local"], {
        cwd: repositoryRoot,
        env: dockerEnv,
        encoding: "utf8",
        stdio: "inherit"
      });
      if (cleanupResultFailed(teardown)) {
        teardownFailed = true;
        console.error(`Disposable teardown failed for ${config.projectName}; run: docker ${composeArgs.join(" ")} down --volumes --remove-orphans --rmi local`);
      }
    }
    const temporaryPaths = [migrationCwd, config.backupDirectory].filter(
      (path): path is string => typeof path === "string"
    );
    if (cleanupTemporaryPaths(temporaryPaths)) {
      teardownFailed = true;
      console.error(`Disposable temporary-directory cleanup failed for ${config.projectName}.`);
    }
  }
  if (teardownFailed) throw new Error("backup_rehearsal_teardown_failed");
  if (rehearsalFailure) throw rehearsalFailure;
  console.log("BACKUP RECOVERY REHEARSAL PASSED");
  console.log("UPDATE MIGRATION REHEARSAL PASSED");
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entrypoint === import.meta.url) {
  try {
    runBackupRecoveryRehearsal();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
