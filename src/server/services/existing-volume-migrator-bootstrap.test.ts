import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sql = readFileSync(fileURLToPath(new URL("../../../scripts/bootstrap-existing-migrator-role.sql", import.meta.url)), "utf8");
const harness = readFileSync(fileURLToPath(new URL("../../../scripts/p1-3-existing-volume-migrator.acceptance-rehearsal.ts", import.meta.url)), "utf8");
const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")) as { scripts?: Record<string,string> };

describe("existing-volume migrator bootstrap", () => {
  it("defines one fail-closed extension-safe ownership protocol without broad reassignment", () => {
    expect(sql).toContain("\\set ON_ERROR_STOP on");
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
    expect(sql).toContain("legacy_migrator_bootstrap_unexpected_existing_role");
    expect(sql).toContain("current_setting('cubby.bootstrap_migrator_password',true)");
    expect(sql).toContain("legacy_migrator_bootstrap_password_missing");
    expect(sql).toContain("20260829210000_global_security_phase8_review_remediation");
    expect(sql).toContain("legacy_migrator_bootstrap_target_migration_present");
    expect(sql).toContain("ALTER DATABASE cubby OWNER TO cubby_migrator");
    expect(sql).toContain("ALTER SCHEMA public OWNER TO cubby_migrator");
    expect(sql).toContain("pg_class");
    expect(sql).toContain("pg_proc");
    expect(sql).toContain("pg_type");
    expect(sql).toContain("dependency.deptype='e'");
    expect(sql).toContain("\\gexec");
    expect(sql).toContain("SET ROLE cubby_migrator");
    expect(sql).toContain("ALTER ROLE cubby NOLOGIN SUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS");
    expect(sql).toContain("PostgreSQL requires the original bootstrap role to retain SUPERUSER");
    expect(sql).toContain("legacy_migrator_bootstrap_verification_failed");
    expect(sql).not.toContain("REASSIGN OWNED");
  });

  it("owns a generated-credential fixed-baseline acceptance lifecycle", () => {
    expect(packageJson.scripts?.["verify:p1-3-migrator-bootstrap"]).toBe("tsx scripts/p1-3-existing-volume-migrator.acceptance-rehearsal.ts");
    for (const marker of [
      "P1_3_MIGRATOR_BOOTSTRAP_BASELINE_PASS",
      "P1_3_MIGRATOR_BOOTSTRAP_PARTIAL_TARGET_REJECTED_PASS",
      "P1_3_MIGRATOR_BOOTSTRAP_TRANSITION_PASS",
      "P1_3_MIGRATOR_BOOTSTRAP_RESTRICTED_ROLES_PASS",
      "P1_3_MIGRATOR_BOOTSTRAP_MIGRATIONS_KEYS_PASS",
      "P1_3_MIGRATOR_BOOTSTRAP_ACCEPTANCE_PASS",
      "P1_3_MIGRATOR_BOOTSTRAP_ACCEPTANCE_CLEANUP_PASS"
    ]) expect(harness).toContain(marker);
    expect(harness).toContain("targetMigrationNames = migrationNames.slice(firstTargetIndex)");
    expect(harness).toContain("bootstrap-existing-migrator-role.sql");
    expect(harness).toContain("PGOPTIONS");
    expect(harness).toContain("CUBBY_MIGRATOR_DB_PASSWORD");
    expect(harness).toContain('"down", "--volumes", "--remove-orphans"');
    expect(harness).toContain("expectedMigrationCount");
    expect(harness).toContain("expectedBaselineCount");
    expect(harness).toContain("firstTargetMigration");
    expect(harness).toContain("slice(firstTargetIndex)");
    expect(harness).toContain("has_function_privilege");
    expect(harness).toContain('has_table_privilege(\'cubby_runtime\', \'"ActivityTimerPauseInterval"\', \'UPDATE\')');
    expect(harness).not.toContain('!== "41"');
    expect(harness).toContain("readdirSync");
    expect(harness).not.toContain('result !== "47|0|4|0|0|1|1|1"');
  });
});
