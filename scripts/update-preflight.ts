import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseBackup } from "../src/server/services/backup-format";

export const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1_000;
export const BACKUP_FREE_SPACE_FLOOR_BYTES = 100 * 1024 * 1024;
export const DATABASE_FREE_SPACE_FLOOR_BYTES = 1024 * 1024 * 1024;

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const BACKUP_TARGET = "/var/lib/cubby/backups";
const DATABASE_TARGET = "/var/lib/postgresql/data";

export type CommandResult =
  | { kind: "success"; stdout: string }
  | { kind: "failure"; stdout?: string; stderr?: string; error?: unknown }
  | { kind: "timeout"; stdout?: string; stderr?: string; error?: unknown };

export type PreflightAdapters = {
  now: () => Date;
  readFile: (path: string) => string;
  run: (program: string, args: readonly string[]) => CommandResult;
};

export type PreflightResult = { exitCode: 0 | 1; lines: string[] };

function runCommand(
  adapters: PreflightAdapters,
  program: string,
  args: readonly string[]
): CommandResult {
  try {
    return adapters.run(program, args);
  } catch {
    return { kind: "failure" };
  }
}

function successfulOutput(result: CommandResult): string | undefined {
  if (result.kind !== "success" || Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES) return undefined;
  return result.stdout;
}

function exactJson<T>(result: CommandResult, validate: (value: unknown) => value is T): T | undefined {
  const output = successfulOutput(result);
  if (output === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(output);
    return validate(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function availableBytes(result: CommandResult): number | undefined {
  const output = successfulOutput(result);
  if (output === undefined) return undefined;
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 2) return undefined;
  const fields = lines[1]!.trim().split(/\s+/);
  if (fields.length < 6 || !/^\d+$/.test(fields[3]!)) return undefined;
  const kib = Number(fields[3]);
  return Number.isSafeInteger(kib) ? kib * 1024 : undefined;
}

function containerId(result: CommandResult): string | undefined {
  const output = successfulOutput(result)?.trim();
  return output && /^[a-zA-Z0-9_.-]+$/.test(output) ? output : undefined;
}

export function runPreflight(args: readonly string[], adapters: PreflightAdapters): PreflightResult {
  const lines: string[] = [];
  let failed = false;
  const check = (name: string, passed: boolean) => {
    lines.push(`${passed ? "PASS" : "FAIL"} ${name}`);
    if (!passed) failed = true;
  };

  const backupPath = args.length === 2 && args[0] === "--backup-file" && args[1] ? args[1] : undefined;
  check("backup-argument", backupPath !== undefined);
  if (!backupPath) {
    check("preflight-summary", false);
    return { exitCode: 1, lines };
  }

  let backupValid = false;
  try {
    const parsed = parseBackup(JSON.parse(adapters.readFile(backupPath)) as unknown);
    const exportedAt = parsed.version === 2 ? Date.parse(parsed.backup.exportedAt) : Number.NaN;
    const age = adapters.now().getTime() - exportedAt;
    backupValid = parsed.version === 2 && parsed.checksumVerified && Number.isFinite(age) && age >= 0 && age <= MAX_BACKUP_AGE_MS;
  } catch {
    backupValid = false;
  }
  check("backup-v2-checksum-freshness", backupValid);

  check("compose-config", successfulOutput(runCommand(adapters, "docker", ["compose", "config", "--quiet"])) !== undefined);

  const services = exactJson<Array<{ Service: string; State: string; Health: string }>>(
    runCommand(adapters, "docker", ["compose", "ps", "--format", "json", "app", "postgres"]),
    (value): value is Array<{ Service: string; State: string; Health: string }> =>
      Array.isArray(value) && value.length === 2 && value.every((item) =>
        typeof item === "object" && item !== null &&
        typeof (item as Record<string, unknown>).Service === "string" &&
        typeof (item as Record<string, unknown>).State === "string" &&
        typeof (item as Record<string, unknown>).Health === "string")
  );
  const healthy = (service: string) => services?.some((item) => item.Service === service && item.State === "running" && item.Health === "healthy") === true;
  check("app-running-healthy", healthy("app"));
  check("postgres-running-healthy", healthy("postgres"));

  const health = exactJson<{ ok: true; body: string }>(
    runCommand(adapters, "docker", ["compose", "exec", "-T", "app", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(async r=>console.log(JSON.stringify({ok:r.ok,body:await r.text()})))"]),
    (value): value is { ok: true; body: string } => typeof value === "object" && value !== null && (value as Record<string, unknown>).ok === true && typeof (value as Record<string, unknown>).body === "string"
  );
  let ready = false;
  try { ready = health?.body !== undefined && JSON.stringify(JSON.parse(health.body)) === '{"status":"ready"}'; } catch { ready = false; }
  check("api-health-ready", ready);

  const environment = exactJson<{ present: true }>(
    runCommand(adapters, "docker", ["compose", "exec", "-T", "app", "node", "-e", "const n=['DATABASE_URL','BETTER_AUTH_SECRET','BETTER_AUTH_URL','TRUSTED_ORIGINS','APP_TIMEZONE'];console.log(JSON.stringify({present:n.every(k=>typeof process.env[k]==='string'&&process.env[k].length>0)}))"]),
    (value): value is { present: true } => typeof value === "object" && value !== null && Object.keys(value).length === 1 && (value as Record<string, unknown>).present === true
  );
  check("required-environment-names", environment?.present === true);

  const appId = containerId(runCommand(adapters, "docker", ["compose", "ps", "-q", "app"]));
  const postgresId = containerId(runCommand(adapters, "docker", ["compose", "ps", "-q", "postgres"]));
  const mount = (id: string | undefined, type: "bind" | "volume", target: string) =>
    id !== undefined &&
    successfulOutput(
      runCommand(adapters, "docker", [
        "inspect",
        "--format",
        `{{range .Mounts}}{{if and (eq .Type \"${type}\") (eq .Destination \"${target}\")}}{{println .Type \"|\" .Destination}}{{end}}{{end}}`,
        id
      ])
    )?.trim() === `${type} | ${target}`;
  check("app-backup-persistent-mount", mount(appId, "bind", BACKUP_TARGET));
  check("postgres-data-persistent-mount", mount(postgresId, "volume", DATABASE_TARGET));

  const backupFree = availableBytes(runCommand(adapters, "docker", ["compose", "exec", "-T", "app", "df", "-Pk", BACKUP_TARGET]));
  const databaseFree = availableBytes(runCommand(adapters, "docker", ["compose", "exec", "-T", "postgres", "df", "-Pk", DATABASE_TARGET]));
  check("backup-filesystem-free-space", backupFree !== undefined && backupFree >= BACKUP_FREE_SPACE_FLOOR_BYTES);
  check("database-filesystem-free-space", databaseFree !== undefined && databaseFree >= DATABASE_FREE_SPACE_FLOOR_BYTES);
  check("preflight-summary", !failed);
  return { exitCode: failed ? 1 : 0, lines };
}

const realAdapters: PreflightAdapters = {
  now: () => new Date(),
  readFile: (path) => readFileSync(path, "utf8"),
  run: (program, args) => {
    const result = spawnSync(program, [...args], { encoding: "utf8", shell: false, timeout: 15_000, maxBuffer: MAX_COMMAND_OUTPUT_BYTES + 1 });
    if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") return { kind: "timeout" };
    return result.status === 0 && !result.error ? { kind: "success", stdout: result.stdout } : { kind: "failure" };
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = runPreflight(process.argv.slice(2), realAdapters);
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  process.exitCode = result.exitCode;
}
