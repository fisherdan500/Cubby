import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../prisma/migrations/20260919120000_platform_owner_setup_claim/migration.sql", import.meta.url),
  "utf8"
);
const provisioner = readFileSync(new URL("../../../scripts/provision-platform-setup-code.mjs", import.meta.url), "utf8");

function functionBody(name: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION "${name}"`);
  const end = migration.indexOf("END $$;", start);
  expect(start).toBeGreaterThan(-1);
  return migration.slice(start, end);
}

describe("platform owner setup-claim migration contract", () => {
  it("writes the verified flag only inside fail-closed SECURITY DEFINER functions", () => {
    for (const name of ["platform_host_verify_user_email", "claim_platform_setup"]) {
      const body = functionBody(name);
      expect(body).toContain("SECURITY DEFINER");
      expect(body).toContain("SET search_path=pg_catalog,public");
      expect(body).toContain("#variable_conflict use_column");
      expect(body).toContain("pg_advisory_xact_lock(1807633529)");
      expect(body).toMatch(/UPDATE public\."User" SET "emailVerified" = true/);
    }
    // Only the runtime role may call them; PUBLIC may not.
    expect(migration).toContain('REVOKE ALL ON FUNCTION "platform_host_verify_user_email"(TEXT,TEXT,TEXT) FROM PUBLIC;');
    expect(migration).toContain('REVOKE ALL ON FUNCTION "claim_platform_setup"(TEXT,TEXT) FROM PUBLIC;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION "platform_host_verify_user_email"(TEXT,TEXT,TEXT) TO cubby_runtime;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION "claim_platform_setup"(TEXT,TEXT) TO cubby_runtime;');
  });

  it("re-checks every host verification precondition in the database", () => {
    const body = functionBody("platform_host_verify_user_email");
    for (const code of [
      "platform_owner_already_bound",
      "platform_owner_bootstrap_user_count_mismatch",
      "platform_owner_not_bound",
      "platform_owner_current_confirmation_mismatch",
      "platform_owner_successor_must_differ",
      "platform_owner_user_not_found",
      "platform_owner_email_confirmation_mismatch",
      "platform_owner_credential_missing",
      "platform_owner_email_already_verified"
    ]) expect(body).toContain(`'${code}'`);
    expect(body).toContain('SELECT count(*) FROM public."User"');
    expect(body).toContain('account_row."providerId" = \'credential\'');
  });

  it("claims only with a live code digest, binds with closed defaults and consumes the code", () => {
    const body = functionBody("claim_platform_setup");
    expect(body).toContain("encode(public.digest(convert_to(scope_code, 'UTF8'), 'sha256'), 'hex')");
    expect(body).toContain('code_row."expiresAt" <= clock_timestamp()');
    expect(body).toContain("'platform_setup_code_invalid'");
    expect(body).toContain("'platform_owner_already_bound'");
    expect(body).toContain("VALUES ('platform', 'closed', false, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
    expect(body).toContain('DELETE FROM public."PlatformSetupCode"');
  });

  it("stores only a digest that no application role can read", () => {
    expect(migration).toContain('CONSTRAINT "PlatformSetupCode_digest_shape_check" CHECK ("codeDigest" ~ \'^[0-9a-f]{64}$\')');
    expect(migration).toContain('CONSTRAINT "PlatformSetupCode_singleton_check" CHECK ("id" = \'platform\')');
    expect(migration).toContain('REVOKE ALL ON TABLE "PlatformSetupCode" FROM PUBLIC;');
    expect(migration).toContain('REVOKE ALL ON TABLE "PlatformSetupCode" FROM cubby_runtime;');
    expect(migration).not.toMatch(/GRANT[^;]*"PlatformSetupCode"/);
  });

  it("issues a code only while no owner exists and prints the code, never its digest or a connection", () => {
    expect(provisioner).toContain("pg_advisory_xact_lock(${lockId})");
    expect(provisioner).toContain('DELETE FROM "PlatformSetupCode"');
    expect(provisioner).toContain('createHash("sha256")');
    expect(provisioner).toContain("randomInt(alphabet.length)");
    expect(provisioner).toContain('const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"');
    expect(provisioner).toContain("const codeLength = 16");
    expect(provisioner).toContain("new PrismaClient({ log: [] })");
    expect(provisioner).not.toMatch(/process\.stdout\.write\([^)]*digest/);
    expect(provisioner).not.toMatch(/DATABASE_URL|process\.env/);
  });
});
