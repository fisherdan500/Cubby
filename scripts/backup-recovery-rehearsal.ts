import { randomBytes } from "node:crypto";
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REHEARSAL_COMPOSE_FILE = "scripts/backup-recovery-rehearsal.compose.yml";
const REHEARSAL_DATABASE = "cubby_backup_rehearsal";
const REHEARSAL_USER = "cubby_rehearsal";

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
  const config: DisposableConfig = {
    projectName: `cubby_backup_rehearsal_${date}_${randomBytes(4).toString("hex")}`,
    databaseName: REHEARSAL_DATABASE,
    databaseUser: REHEARSAL_USER,
    composeFile: REHEARSAL_COMPOSE_FILE,
    backupDirectory: mkdtempSync(resolve(tmpdir(), "cubby-backup-rehearsal-files-"))
  };
  assertDisposableRehearsalConfig(config);

  const composeArgs = ["compose", "--project-name", config.projectName, "--file", config.composeFile];
  const rehearsalPassword = randomBytes(24).toString("hex");
  const rehearsalAuthSecret = randomBytes(32).toString("hex");
  const rehearsalAppPassword = randomBytes(24).toString("base64url");
  const dockerEnv = isolatedDockerEnvironment(rehearsalPassword, rehearsalAuthSecret, config.backupDirectory);
  const migrationCwd = mkdtempSync(resolve(tmpdir(), "cubby-backup-rehearsal-"));
  const isolatedPrismaDir = resolve(migrationCwd, "prisma");
  const handoffFile = resolve(migrationCwd, "app-probe-handoff.json");
  let composeAttempted = false;
  let teardownFailed = false;

  console.log(`Starting isolated disposable project ${config.projectName}.`);
  console.log("The rehearsal does not load .env, use the normal Compose file, or attach to the normal database volume.");

  try {
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
    mkdirSync(isolatedPrismaDir, { recursive: true });
    const schema = resolve(isolatedPrismaDir, "schema.prisma");
    copyFileSync(resolve(repositoryRoot, "prisma/schema.prisma"), schema);
    cpSync(resolve(repositoryRoot, "prisma/migrations"), resolve(isolatedPrismaDir, "migrations"), { recursive: true });
    run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", schema], { cwd: migrationCwd, env });
    const vitestCli = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
    run(
      process.execPath,
      [vitestCli, "run", "--config", "scripts/backup-recovery-rehearsal.vitest.config.ts"],
      { cwd: repositoryRoot, env }
    );

    run("docker", [...composeArgs, "up", "--detach", "--wait", "--build", "app"], {
      cwd: repositoryRoot,
      env: dockerEnv
    });
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
  } finally {
    if (composeAttempted) {
      const teardown = spawnSync("docker", [...composeArgs, "down", "--volumes", "--remove-orphans", "--rmi", "local"], {
        cwd: repositoryRoot,
        env: dockerEnv,
        encoding: "utf8",
        stdio: "inherit"
      });
      if (teardown.error || teardown.status !== 0) {
        teardownFailed = true;
        console.error(`Disposable teardown failed for ${config.projectName}; run: docker ${composeArgs.join(" ")} down --volumes --remove-orphans --rmi local`);
      }
    }
    rmSync(migrationCwd, { recursive: true, force: true });
    rmSync(config.backupDirectory, { recursive: true, force: true });
  }
  if (teardownFailed) throw new Error("backup_rehearsal_teardown_failed");
  console.log("BACKUP RECOVERY REHEARSAL PASSED");
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
