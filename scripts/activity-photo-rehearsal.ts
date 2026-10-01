import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { DISPOSABLE_RUNTIME_ROLES, createDisposableRuntimeRolesArgs } from "./disposable-runtime-roles";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const database = "cubby_activity_photo_acceptance";
const composeFile = "scripts/activity-photo.compose.yml";

function run(command: string, args: string[], env: NodeJS.ProcessEnv, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (result.error || result.status !== 0) throw new Error(`activity_photo_rehearsal_failed: ${command} ${args.join(" ")}`);
  return String(result.stdout ?? "");
}

/**
 * `--wait` can be satisfied by the initdb bootstrap server, which then shuts down and restarts
 * before the first real connection. A role-creation command issued in that window fails with
 * "is the server running on that socket?", and the deploy that follows then fails on a missing
 * role - which reads as a migration fault and poisons the migration tracking table.
 *
 * So: wait for a settled server, provision, then PROVE the roles exist by counting them in the
 * catalog. Readiness is not the same as ready.
 */
function provisionRuntimeRoles(compose: string[], env: NodeJS.ProcessEnv) {
  const psql = (sql: string) => [
    ...compose, "exec", "--no-TTY", "postgres",
    "psql", "--username", database, "--dbname", database,
    "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align", "--command", sql
  ];

  let settled = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const probe = spawnSync("docker", psql("SELECT 1"), { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (probe.status === 0 && String(probe.stdout ?? "").trim() === "1") { settled = true; break; }
    sleepSync(1000);
  }
  if (!settled) throw new Error("activity_photo_postgres_never_settled");

  run("docker", [...compose, "exec", "--no-TTY", "postgres", ...createDisposableRuntimeRolesArgs(database, database)], env);

  const counted = run("docker", psql(
    `SELECT count(*) FROM pg_roles WHERE rolname IN (${DISPOSABLE_RUNTIME_ROLES.map((role) => `'${role}'`).join(",")})`
  ), env, true).trim();
  if (counted !== String(DISPOSABLE_RUNTIME_ROLES.length)) {
    throw new Error(`activity_photo_roles_not_provisioned: expected ${DISPOSABLE_RUNTIME_ROLES.length}, found ${counted}`);
  }
}

function sleepSync(ms: number) {
  // A blocking wait between container probes; this script is a sequential rehearsal driver.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function runActivityPhotoRehearsal() {
  const project = `cubby_activity_photo_acceptance_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const temp = mkdtempSync(resolve(tmpdir(), "cubby-activity-photo-acceptance-"));
  const env: NodeJS.ProcessEnv = { ...process.env, COMPOSE_DISABLE_ENV_FILE: "true", CUBBY_PHOTO_UPLOAD_ACCEPTANCE_PASSWORD: password, NODE_ENV: "test" };
  delete env.DATABASE_URL;
  delete env.DIRECT_URL;
  delete env.COMPOSE_FILE;
  delete env.COMPOSE_PROJECT_NAME;
  const compose = ["compose", "--project-name", project, "--file", composeFile];
  try {
    run("docker", [...compose, "up", "--detach", "--wait", "postgres"], env);
    const published = run("docker", [...compose, "port", "postgres", "5432"], env, true).trim();
    const port = published.match(/:(\d+)$/)?.[1];
    if (!port) throw new Error("activity_photo_port_invalid");
    const databaseUrl = `postgresql://${database}:${password}@127.0.0.1:${port}/${database}?schema=public`;
    // The migrations grant to the production role names, so those roles have to exist before deploy.
    provisionRuntimeRoles(compose, env);
    cpSync(resolve(root, "prisma"), resolve(temp, "prisma"), { recursive: true });
    const prismaCli = resolve(root, "node_modules/prisma/build/index.js");
    run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", resolve(temp, "prisma/schema.prisma")], { ...env, DATABASE_URL: databaseUrl });
    const vitestCli = resolve(root, "node_modules/vitest/vitest.mjs");
    run(process.execPath, [vitestCli, "run", "--config", "scripts/activity-photo.vitest.config.ts"], { ...env, DATABASE_URL: databaseUrl });
  } finally {
    spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans"], { cwd: root, env, stdio: "ignore" });
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runActivityPhotoRehearsal();
