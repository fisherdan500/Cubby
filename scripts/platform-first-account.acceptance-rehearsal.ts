import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { createDisposableRuntimeRolesArgs } from "./disposable-runtime-roles";

// Disposable acceptance gate for first-account setup: it boots its own Postgres, applies the real
// migrations, provisions the production role names, and runs create_platform_owner_account as the
// runtime role through every outcome, including two setups racing each other.
//
// Nothing here touches the normal runtime: its own Compose project, database, volume and network, and
// no .env.

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const composeFile = "scripts/platform-first-account.acceptance.compose.yml";
const database = "cubby_first_account_acceptance";

function run(command: string, args: string[], env: NodeJS.ProcessEnv, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (result.error || result.status !== 0) throw new Error(`platform_first_account_acceptance_failed: ${command} ${args.join(" ")}`);
  return String(result.stdout ?? "");
}

export function runPlatformFirstAccountAcceptanceRehearsal() {
  const project = `cubby_first_account_acceptance_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const temp = mkdtempSync(resolve(tmpdir(), "cubby-first-account-acceptance-"));
  const env: NodeJS.ProcessEnv = { ...process.env, COMPOSE_DISABLE_ENV_FILE: "true", CUBBY_FIRST_ACCOUNT_ACCEPTANCE_PASSWORD: password, NODE_ENV: "test" };
  delete env.DATABASE_URL;
  delete env.DIRECT_URL;
  delete env.COMPOSE_FILE;
  delete env.COMPOSE_PROJECT_NAME;
  const compose = ["compose", "--project-name", project, "--file", composeFile];
  try {
    run("docker", [...compose, "up", "--detach", "--wait", "postgres"], env);
    const published = run("docker", [...compose, "port", "postgres", "5432"], env, true).trim();
    const port = published.match(/:(\d+)$/)?.[1];
    if (!port) throw new Error("platform_first_account_acceptance_port_invalid");
    const databaseUrl = `postgresql://${database}:${password}@127.0.0.1:${port}/${database}?schema=public`;
    run("docker", [...compose, "exec", "--no-TTY", "postgres", ...createDisposableRuntimeRolesArgs(database, database)], env);
    cpSync(resolve(root, "prisma"), resolve(temp, "prisma"), { recursive: true });
    const prismaCli = resolve(root, "node_modules/prisma/build/index.js");
    run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", resolve(temp, "prisma/schema.prisma")], { ...env, DATABASE_URL: databaseUrl });
    const vitestCli = resolve(root, "node_modules/vitest/vitest.mjs");
    run(process.execPath, [vitestCli, "run", "--config", "scripts/platform-first-account.acceptance.vitest.config.ts"], { ...env, DATABASE_URL: databaseUrl });
  } finally {
    spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans"], { cwd: root, env, stdio: "ignore" });
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runPlatformFirstAccountAcceptanceRehearsal();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
