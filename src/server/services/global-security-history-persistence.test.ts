import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260829190000_global_security_private_history_reader/migration.sql", import.meta.url));

describe("global security private-history persistence", () => {
  it("grants only the guarded fixed-search-path reader while keeping runtime table reads revoked", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION "read_global_security_history"');
    expect(migration).toContain("SECURITY DEFINER SET search_path=pg_catalog,public");
    expect(migration).toContain('FROM public."authorize_global_session_security"(scope_user_id, scope_session_id, NULL)');
    expect(migration).toContain('"credentialVersion" IS DISTINCT FROM scope_credential_version');
    expect(migration).toContain('event_row."userId"=scope_user_id');
    expect(migration).toContain('event_row."sequence"<=snapshot_max_sequence');
    expect(migration).toContain('event_row."sequence"<scope_last_sequence');
    expect(migration).toContain('REVOKE ALL ON TABLE "GlobalSecurityEvent","GlobalSecurityIncident","GlobalSecurityThrottleKey" FROM cubby_runtime');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION "read_global_security_history"');
    expect(migration).not.toContain('GRANT SELECT ON TABLE "GlobalSecurityEvent"');
  });
});
