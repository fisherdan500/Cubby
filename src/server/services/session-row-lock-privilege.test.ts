import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression: 20260824140000_global_security_foundation revoked UPDATE on "Session" from cubby_runtime.
 * PostgreSQL requires UPDATE privilege for a FOR UPDATE row lock, so every operation that locked the
 * caller's session from the runtime role failed with 42501 permission denied for table Session -
 * silently breaking activity, timer, calendar, appearance, integration and invitation mutations.
 */
const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migrationDir = "prisma/migrations/20260916120000_actor_session_lock_function";
const migration = read(`${migrationDir}/migration.sql`);

function serverSources() {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) files.push(path);
    }
  };
  walk("src/server");
  return files;
}

describe("session row locks and runtime privileges", () => {
  it("never takes a FOR UPDATE row lock on Session from application code", () => {
    const offenders = serverSources().filter((file) => /FROM\s+"Session"[\s\S]{0,200}?FOR UPDATE/.test(read(file)));
    expect(offenders, `these run as the runtime role, which cannot lock "Session": ${offenders.join(", ")}`).toEqual([]);
  });

  it("locks through fail-closed SECURITY DEFINER functions instead", () => {
    // Callers keep their own identity, expiry and sign-in-age checks; only the lock target changes.
    const callers = [
      "src/server/services/browser-operations.ts",
      "src/server/services/browser-operation-status.ts",
      "src/server/services/account-appearance.ts",
      "src/server/services/account-browser-operation-status.ts",
      "src/server/services/integrations.ts",
      "src/server/services/invites.ts",
      "src/server/services/household-leave.ts"
    ];
    for (const caller of callers) expect(read(caller), caller).toContain('"lock_actor_session_for_operation"(');
    expect(read("src/server/services/invites.ts")).toContain('"lock_user_sessions_for_operation"(');

    for (const fn of ['"lock_actor_session_for_operation"', '"lock_user_sessions_for_operation"']) {
      expect(migration).toContain(`CREATE OR REPLACE FUNCTION ${fn}`);
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${fn}`);
    }
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).toContain("SET search_path=pg_catalog,public");
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION "lock_actor_session_for_operation"\(TEXT,TEXT\) TO cubby_runtime;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION "lock_user_sessions_for_operation"\(TEXT\) TO cubby_runtime;/);
  });

  it("keeps the runtime role locked out of writing Session", () => {
    // The fix must not widen table privileges; the 2026-08-24 revoke stands.
    expect(migration).not.toMatch(/GRANT\s+[^;]*UPDATE[^;]*ON\s+(TABLE\s+)?"Session"/i);
    expect(read("prisma/migrations/20260824140000_global_security_foundation/migration.sql"))
      .toContain('REVOKE INSERT, UPDATE, DELETE ON "Session","SessionSecurityActivity" FROM cubby_runtime;');
  });

  it("keeps the caller-side checks that run after the lock", () => {
    expect(read("src/server/services/browser-operations.ts")).toContain('if (!session) throw new Error("forbidden");');
    expect(read("src/server/services/browser-operation-status.ts")).toContain('if (!currentSession) throw new Error("unauthenticated");');
    expect(read("src/server/services/account-appearance.ts")).toContain('if (!currentSession) throw new Error("stale_context");');
    // Sign-in age is still enforced where the operation is sensitive.
    expect(read("src/server/services/integrations.ts")).toContain("SESSION_FRESH_AGE_SECONDS");
    expect(read("src/server/services/household-leave.ts")).toContain("SESSION_FRESH_AGE_SECONDS");
  });
});
