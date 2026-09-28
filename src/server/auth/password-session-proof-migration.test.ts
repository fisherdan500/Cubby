import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = new URL("../../../prisma/migrations/20261003120100_admin_assisted_session_proof/migration.sql", import.meta.url);

describe("admin-assisted Session credential proof migration", () => {
  it("adds the exact nullable proof shape, lengths, purpose, nonce uniqueness, and immutability", () => {
    const migration = readFileSync(migrationPath, "utf8");
    for (const field of ["credentialProofPurpose", "credentialProofHashDigest", "credentialProofIssuedAt", "credentialProofNonce", "credentialProofKeyVersion", "credentialProofMac"]) {
      expect(migration).toContain(`\"${field}\"`);
    }
    expect(migration).toContain('ADD COLUMN "credentialProofHashDigest" BYTEA');
    expect(migration).toContain('ADD COLUMN "credentialProofIssuedAt" TIMESTAMP(3)');
    expect(migration).toContain('octet_length("credentialProofHashDigest") = 32');
    expect(migration).toContain('octet_length("credentialProofNonce") = 32');
    expect(migration).toContain('octet_length("credentialProofMac") = 32');
    expect(migration).toContain("credential_sign_in");
    expect(migration).toContain('CREATE UNIQUE INDEX "Session_credentialProofNonce_key"');
    expect(migration).toContain('CREATE TRIGGER "Session_credential_proof_immutable"');
  });

  it("installs the lexically first fixed-search-path definer guard with the global lock first", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const functionStart = migration.indexOf('CREATE FUNCTION "guard_session_credential_proof_v1"');
    const functionEnd = migration.indexOf('END $$;', functionStart);
    const guard = migration.slice(functionStart, functionEnd);
    expect(migration).toContain('CREATE TRIGGER "Session_00_credential_proof_guard" BEFORE INSERT');
    expect(guard).toContain("SECURITY DEFINER SET search_path=pg_catalog,public");
    expect(guard.indexOf("global-security-transition:v1")).toBeLessThan(guard.indexOf("session_user <> 'cubby_auth'"));
    expect(guard).toContain('digest(convert_to(NEW."token",\'UTF8\'),\'sha256\')');
    expect(guard).toContain('digest(convert_to(credential_hash,\'UTF8\'),\'sha256\')');
    expect(guard).toContain("timestamp_send(NEW.\"credentialProofIssuedAt\")");
    expect(guard).toContain("int4send(NEW.\"credentialProofKeyVersion\")");
    expect(guard).toContain("INTERVAL '5 seconds'");
    expect(guard).toContain("INTERVAL '10 minutes'");
    expect(guard).toContain('FROM public."FreshAuthAttestationKey"');
    expect(guard).toContain('credential_proof_constant_time_equal_v1');
  });

  it("keeps proof/key authority private and initializes activity plus event atomically for auth inserts", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain('REVOKE ALL ON FUNCTION "guard_session_credential_proof_v1"() FROM PUBLIC,cubby_runtime,cubby_auth');
    expect(migration).not.toContain('GRANT SELECT ON TABLE "FreshAuthAttestationKey" TO cubby_auth');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION "write_global_security_session_sign_in_event"()');
    expect(migration).toContain('public."initialize_global_session_security_activity"(NEW."userId",NEW."id")');
    expect(migration).toContain("'sign_in_succeeded'");
    expect(migration).toContain("IF session_user <> 'cubby_auth' THEN RETURN NEW; END IF;");
  });
});
