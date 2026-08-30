import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "prisma/migrations/20260829200000_global_security_operator_aggregate/migration.sql"
);
const provisionerPath = resolve(process.cwd(), "scripts/provision-security-runtime-role.mjs");

describe("security operator aggregate persistence", () => {
  it("creates only the fixed-search-path, bounded content-free incident aggregate", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain('CREATE OR REPLACE FUNCTION "read_global_security_operator_aggregate"(scope_from DATE, scope_to DATE)');
    expect(migration).toContain("SECURITY DEFINER SET search_path=pg_catalog,public");
    expect(migration).toContain("scope_from >= scope_to OR scope_to > scope_from + 31");
    expect(migration).toContain('FROM public."GlobalSecurityIncident" incident_row');
    expect(migration).toContain('incident_row."windowStartedAt" AT TIME ZONE \'UTC\'');
    expect(migration).toContain('"coarseTimeBucket" DATE');
    expect(migration).toContain('"incidentCount" BIGINT');
    expect(migration).toContain('GROUP BY\n    incident_row."layer",\n    incident_row."state",\n    ((incident_row."windowStartedAt" AT TIME ZONE \'UTC\') AT TIME ZONE \'UTC\')::DATE');
    expect(migration).toContain('REVOKE ALL ON FUNCTION "read_global_security_operator_aggregate"(DATE,DATE) FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON FUNCTION "read_global_security_operator_aggregate"(DATE,DATE) FROM cubby_runtime');
    expect(migration).toContain('REVOKE ALL ON FUNCTION "read_global_security_operator_aggregate"(DATE,DATE) FROM cubby_auth');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION "read_global_security_operator_aggregate"(DATE,DATE) TO cubby_security_operator');
    expect(migration).not.toContain('normalizedKey');
    expect(migration).not.toContain('"userId"');
    expect(migration).not.toContain('failureCount');
  });

  it("keeps the operator role unowned, non-member, non-elevated, and without table grants", () => {
    const provisioner = readFileSync(provisionerPath, "utf8");

    expect(provisioner).toContain('roles.push({ role: "cubby_security_operator", password: operatorPassword })');
    expect(provisioner).toContain("NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    expect(provisioner).toContain("cubby_restricted_role_owns_objects");
    expect(provisioner).toContain("REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public");
    expect(provisioner).toContain("REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public");
    expect(provisioner).toContain("REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public");
    expect(provisioner).toContain("REVOKE ALL ON SCHEMA public");
    expect(provisioner).toContain("REVOKE ALL PRIVILEGES ON DATABASE");
  });
});
