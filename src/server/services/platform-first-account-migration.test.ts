import { existsSync, readFileSync } from "node:fs";
import { hashPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../../prisma/migrations/20260923120000_platform_first_account_setup/migration.sql",
  import.meta.url
);

function migration() {
  expect(existsSync(migrationUrl)).toBe(true);
  return readFileSync(migrationUrl, "utf8");
}

function functionBody() {
  const sql = migration();
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION "create_platform_owner_account"');
  const end = sql.indexOf("END $$;", start);
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start, end);
}

describe("platform first-account migration contract", () => {
  it("creates the first account only inside a fail-closed SECURITY DEFINER function the runtime may call", () => {
    const sql = migration();
    const body = functionBody();
    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("SET search_path=pg_catalog,public");
    expect(body).toContain("#variable_conflict use_column");
    expect(sql).toContain('REVOKE ALL ON FUNCTION "create_platform_owner_account"(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION "create_platform_owner_account"(TEXT,TEXT,TEXT,TEXT) TO cubby_runtime;');
  });

  it("serializes with credential creation and platform binding before deciding the install is empty", () => {
    const body = functionBody();
    const globalLock = body.indexOf("pg_advisory_xact_lock(hashtextextended('global-security-transition:v1', 0))");
    const platformLock = body.indexOf("pg_advisory_xact_lock(1807633529)");
    const emptyCheck = body.indexOf('EXISTS (SELECT 1 FROM public."User")');
    // The same order invitation credential setup takes, so the two can never deadlock.
    expect(globalLock).toBeGreaterThan(-1);
    expect(platformLock).toBeGreaterThan(globalLock);
    expect(emptyCheck).toBeGreaterThan(platformLock);
    expect(body).toContain("'platform_owner_already_bound'");
    expect(body).toContain("'platform_setup_install_not_empty'");
  });

  it("accepts only a live setup code, with one outcome for missing, expired or wrong", () => {
    const body = functionBody();
    expect(body).toContain("encode(public.digest(convert_to(scope_code, 'UTF8'), 'sha256'), 'hex')");
    expect(body).toContain('code_row."expiresAt" <= clock_timestamp()');
    expect(body).toContain("'platform_setup_code_invalid'");
  });

  it("creates a complete credential identity, binds it with closed defaults and consumes the code", () => {
    const body = functionBody();
    expect(body).toContain("'platform_setup_account_invalid'");
    expect(body).toMatch(/INSERT INTO public\."User"\([^)]*"emailVerified"[^)]*\) VALUES\([^;]*true/);
    expect(body).toContain("lower(btrim(scope_email))");
    expect(body).toMatch(/INSERT INTO public\."Account"\([^)]*"providerId"[^;]*'credential'/);
    expect(body).toMatch(/INSERT INTO public\."AccountSecurityState"[^;]*VALUES\([^;]*1,1/);
    expect(body).toContain("VALUES ('platform', 'closed', false, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
    expect(body).toContain('DELETE FROM public."PlatformSetupCode"');
  });

  it("receives only a password hash, never a password, and refuses anything shaped otherwise", async () => {
    const sql = migration();
    expect(sql).toMatch(/"create_platform_owner_account"\(\s*scope_code TEXT,\s*scope_name TEXT,\s*scope_email TEXT,\s*scope_password_hash TEXT\s*\)/);
    expect(sql).not.toMatch(/scope_password\b(?!_hash)/);

    // The database's shape check has to accept what Better Auth actually produces, and not a password.
    const hashShape = "^[0-9a-f]{16,}:[0-9a-f]{32,}$";
    expect(functionBody()).toContain(`scope_password_hash !~ '${hashShape}'`);
    expect(new RegExp(hashShape).test(await hashPassword("correct horse battery"))).toBe(true);
    expect(new RegExp(hashShape).test("correct horse battery")).toBe(false);
  });
});
