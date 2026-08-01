import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const composeFile = "scripts/sprout-preview-commit.acceptance.compose.yml";

function run(command: string, args: string[], env: NodeJS.ProcessEnv, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (result.error || result.status !== 0) throw new Error(`sprout_preview_commit_acceptance_failed: ${command} ${args.join(" ")}`);
  return String(result.stdout ?? "");
}

function composeEnv(overrides: Record<string, string>) {
  const env: NodeJS.ProcessEnv = { ...process.env, ...overrides, COMPOSE_DISABLE_ENV_FILE: "true" };
  for (const key of [
    "DATABASE_URL",
    "DIRECT_URL",
    "COMPOSE_FILE",
    "COMPOSE_PROJECT_NAME",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "CUBBY_SPROUT_STAGING_HOST_DIR",
    "CUBBY_SPROUT_STAGING_KEY_FILE",
    "SPROUT_STAGING_DIRECTORY",
    "SPROUT_STAGING_KEY_FILE",
    "SPROUT_STAGING_KEY_VERSION"
  ]) delete env[key];
  return { ...env, ...overrides, COMPOSE_DISABLE_ENV_FILE: "true" };
}

export function runSproutPreviewCommitAcceptance() {
  const suffix = randomBytes(6).toString("hex");
  const project = `cubby_sprout_acceptance_${suffix}`;
  const user = `sprout_${suffix}`;
  const database = `sprout_${suffix}`;
  const password = randomBytes(24).toString("base64url");
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-sprout-preview-commit-"));
  const secretFile = resolve(temporaryRoot, "cubby_sprout_staging_key");
  const stagingRoot = resolve(temporaryRoot, "staging");
  const copiedPrisma = resolve(temporaryRoot, "prisma");
  const baseEnv = composeEnv({
    CUBBY_SPROUT_ACCEPTANCE_DATABASE: database,
    CUBBY_SPROUT_ACCEPTANCE_USER: user,
    CUBBY_SPROUT_ACCEPTANCE_PASSWORD: password,
    CUBBY_SPROUT_ACCEPTANCE_SECRET_FILE: secretFile,
    NODE_ENV: "test",
    APP_TIMEZONE: "UTC",
    BETTER_AUTH_SECRET: "sprout-preview-commit-acceptance-secret",
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    SPROUT_STAGING_DIRECTORY: stagingRoot,
    SPROUT_STAGING_KEY_FILE: secretFile,
    SPROUT_STAGING_KEY_VERSION: "acceptance-v1"
  });
  const compose = ["compose", "--project-name", project, "--file", composeFile];

  writeFileSync(secretFile, randomBytes(32).toString("base64"), { mode: 0o600 });
  cpSync(resolve(root, "prisma"), copiedPrisma, { recursive: true });
  try {
    run("docker", [...compose, "up", "--detach", "--wait", "postgres"], baseEnv);
    const published = run("docker", [...compose, "port", "postgres", "5432"], baseEnv, true).trim();
    const port = published.match(/^127\.0\.0\.1:(\d+)$/)?.[1];
    if (!port) throw new Error("sprout_preview_commit_acceptance_loopback_port_invalid");
    const databaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?schema=public`;
    const prismaCli = resolve(root, "node_modules/prisma/build/index.js");
    run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", resolve(copiedPrisma, "schema.prisma")], { ...baseEnv, DATABASE_URL: databaseUrl });
    const vitestCli = resolve(root, "node_modules/vitest/vitest.mjs");
    run(process.execPath, [vitestCli, "run", "--config", "scripts/sprout-preview-commit.acceptance.vitest.config.ts"], { ...baseEnv, DATABASE_URL: databaseUrl });
    console.log("SPROUT_PREVIEW_COMMIT_ACCEPTANCE_PASS");
  } finally {
    spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans"], { cwd: root, env: baseEnv, stdio: "ignore" });
    const containers = run("docker", ["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`], baseEnv, true).trim();
    const volumes = run("docker", ["volume", "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`], baseEnv, true).trim();
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (containers || volumes || existsSync(temporaryRoot)) throw new Error("sprout_preview_commit_acceptance_cleanup_incomplete");
    console.log("SPROUT_PREVIEW_COMMIT_ACCEPTANCE_CLEANUP_PASS");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runSproutPreviewCommitAcceptance();
