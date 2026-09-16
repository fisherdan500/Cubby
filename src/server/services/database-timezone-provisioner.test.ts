import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const provisioner = read("scripts/provision-database-timezone.mjs");
const entrypoint = read("docker/entrypoint.sh");
const dockerfile = read("Dockerfile");
const compose = read("docker-compose.yml");
const rehearsalCompose = read("scripts/backup-recovery-rehearsal.compose.yml");
const packageJson = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

/** Returns one top-level Compose service block; working copies may use CRLF line endings. */
function serviceBlock(source: string, service: string) {
  const header = source.search(new RegExp(`\\r?\\n {2}${service}:\\r?\\n`));
  expect(header, service).toBeGreaterThanOrEqual(0);
  const bodyStart = source.indexOf("\n", header + 1) + 1;
  const rest = source.slice(bodyStart);
  const end = rest.search(/\r?\n {2}[a-z][a-z0-9_-]*:\r?\n|\r?\n[a-z]/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("database timezone invariant", () => {
  it("pins the database default to UTC as the owner and fails closed with a fixed marker", () => {
    expect(provisioner).toContain("ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC'");
    expect(provisioner).toContain("cubby_startup phase=database_timezone status=failed");
    expect(provisioner).not.toMatch(/process\.std(?:out|err)\.write\((?:error|e)\b/);
  });

  it("rejects role-level overrides and verifies the runtime role's own session reports UTC", () => {
    expect(provisioner).toContain("pg_db_role_setting");
    expect(provisioner).toContain("lower(split_part(c.entry, '=', 1)) = 'timezone'");
    expect(provisioner).toContain("new PrismaClient({ datasourceUrl: runtimeUrl })");
    expect(provisioner).toContain("current_setting('TimeZone')");
    expect(provisioner).toContain('zones[0].zone !== "UTC"');
  });

  it("runs after secrets are scrubbed and before any migration connection, and is packaged into the image", () => {
    const step = 'CUBBY_RUNTIME_DATABASE_URL="$DATABASE_URL" DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-database-timezone.mjs';
    expect(entrypoint).toContain(step);
    expect(entrypoint).toContain("write_startup_status database_timezone failed");
    expect(entrypoint.indexOf("unset CUBBY_SECURITY_OPERATOR_DB_PASSWORD")).toBeLessThan(entrypoint.indexOf(step));
    expect(entrypoint.indexOf(step)).toBeLessThan(entrypoint.indexOf("db execute --stdin"));
    expect(entrypoint.indexOf(step)).toBeLessThan(entrypoint.indexOf("migrate deploy"));
    expect(dockerfile).toContain("COPY --from=builder --chown=node:node /app/dist/provision-database-timezone.mjs ./provision-database-timezone.mjs");
    expect(packageJson.scripts["build:database-timezone"]).toContain("scripts/provision-database-timezone.mjs");
    expect(packageJson.scripts.build).toContain("npm run build:database-timezone");
  });

  it("initializes PostgreSQL in UTC while the app keeps APP_TIMEZONE for display", () => {
    const postgres = serviceBlock(compose, "postgres");
    const app = serviceBlock(compose, "app");
    expect(postgres).toMatch(/^\s+TZ: UTC\r?$/m);
    expect(postgres).not.toContain("TZ: ${APP_TIMEZONE");
    expect(app).toContain("APP_TIMEZONE: ${APP_TIMEZONE:-America/New_York}");
  });

  it("reproduces a non-UTC PostgreSQL initialization in the disposable backup rehearsal", () => {
    expect(serviceBlock(rehearsalCompose, "postgres")).toMatch(/^\s+TZ: America\/New_York\r?$/m);
  });
});
