import { cpSync, mkdtempSync, rmSync } from "node:fs";
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

function run(command: string, args: string[], env: NodeJS.ProcessEnv, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (result.error || result.status !== 0) throw new Error(`integrity_suite_acceptance_failed: ${command} ${args.join(" ")}`);
  return String(result.stdout ?? "");
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
    run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", resolve(temp, "prisma/schema.prisma")], { ...env, DATABASE_URL: databaseUrl });
    const vitestCli = resolve(root, "node_modules/vitest/vitest.mjs");
    run(process.execPath, [vitestCli, "run", "--config", "scripts/integrity-suite.acceptance.vitest.config.ts"], { ...env, DATABASE_URL: databaseUrl });
  } finally {
    spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans"], { cwd: root, env, stdio: "ignore" });
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runIntegritySuiteAcceptanceRehearsal();
