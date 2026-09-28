import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schemaUrl = new URL("../../../prisma/schema.prisma", import.meta.url);
const enumMigrationUrl = new URL(
  "../../../prisma/migrations/20261003120200_admin_assisted_browser_operation_keys/migration.sql",
  import.meta.url
);
const persistenceMigrationUrl = new URL(
  "../../../prisma/migrations/20261003120300_admin_assisted_credential_boundary/migration.sql",
  import.meta.url
);

function schemaBlock(source: string, kind: "model" | "enum", name: string) {
  return source
    .split(new RegExp(`\\r?\\n(?=${kind}\\s)`))
    .find((candidate) => candidate.startsWith(`${kind} ${name} `)) ?? "";
}

function sqlFunction(source: string, name: string) {
  const match = new RegExp(`CREATE(?: OR REPLACE)? FUNCTION (?:public\\.)?"${name}"`).exec(source);
  const start = match?.index ?? -1;
  if (start < 0) return "";
  const next = source.indexOf("\nCREATE ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

function indexOrder(source: string, values: string[]) {
  const executable = source.slice(Math.max(0, source.indexOf("\nBEGIN\n")));
  const positions = values.map((value) => executable.indexOf(value));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect([...positions].sort((left, right) => left - right)).toEqual(positions);
}

describe("admin-assisted credential persistence boundary", () => {
  it("adds the two browser keys in an enum-only committed migration", () => {
    expect(existsSync(enumMigrationUrl)).toBe(true);
    if (!existsSync(enumMigrationUrl)) return;
    const migration = readFileSync(enumMigrationUrl, "utf8");
    expect(migration).toContain("ALTER TYPE \"BrowserOperationKey\" ADD VALUE IF NOT EXISTS 'member.account.create';");
    expect(migration).toContain("ALTER TYPE \"BrowserOperationKey\" ADD VALUE IF NOT EXISTS 'member.password.reset';");
    expect(migration.match(/ALTER TYPE/g)).toHaveLength(2);
    expect(migration).not.toMatch(/CREATE TABLE|CREATE FUNCTION|CREATE TRIGGER|INSERT INTO|UPDATE |DELETE FROM/);
    expect(migration).not.toContain("BEGIN;");
  });

  it("models exact receipt and required-change state shapes with only target-user live relations", () => {
    const schema = readFileSync(schemaUrl, "utf8");
    const keys = schemaBlock(schema, "enum", "BrowserOperationKey");
    const receipt = schemaBlock(schema, "model", "AssistedCredentialMutation");
    const state = schemaBlock(schema, "model", "AssistedAccountState");
    expect(keys).toMatch(/memberAccountCreate\s+@map\("member\.account\.create"\)/);
    expect(keys).toMatch(/memberPasswordReset\s+@map\("member\.password\.reset"\)/);

    for (const field of [
      "householdId", "operationId", "operationKey", "browserBindingId", "actorUserId", "actorSessionId",
      "actorMemberId", "targetUserId", "targetMemberId", "accountId", "openingFingerprint", "intentFingerprint",
      "oldCredentialVersion", "newCredentialVersion", "oldSessionSecurityVersion", "newSessionSecurityVersion",
      "passwordHashDigest", "requireFirstLoginPasswordChange", "attestationNonce", "attestationKeyVersion",
      "attestationIssuedAt", "attestationMacDigest", "createdAt"
    ]) expect(receipt).toMatch(new RegExp(`\\b${field}\\b`));
    expect(receipt).toContain("@@id([householdId, operationId])");
    expect(receipt).toMatch(/browserBindingId\s+String\s+@unique/);
    expect(receipt).toMatch(/attestationNonce\s+Bytes\s+@unique/);
    expect(receipt).toMatch(/targetUser\s+User\s+@relation\([^\n]*onDelete: Cascade/);
    expect(receipt).not.toMatch(/actorUser\s+User|actorSession\s+Session|actorMember\s+HouseholdMember|targetMember\s+HouseholdMember|binding\s+BrowserOperationBinding|account\s+Account|household\s+Household/);

    expect(state).toMatch(/userId\s+String\s+@id/);
    expect(state).toMatch(/requiredChangeCredentialVersion\s+Int\?/);
    expect(state).toContain("@@unique([assistedCreationHouseholdId, assistedCreationOperationId])");
    expect(state).toMatch(/user\s+User\s+@relation\([^\n]*onDelete: Cascade/);
    expect(state).not.toMatch(/creationHousehold\s+Household|creationMember\s+HouseholdMember/);
  });

  it("creates exact SQL types, checks, indexes, historical identifiers, and closed lifecycle guards", () => {
    expect(existsSync(persistenceMigrationUrl)).toBe(true);
    if (!existsSync(persistenceMigrationUrl)) return;
    const sql = readFileSync(persistenceMigrationUrl, "utf8");
    expect(sql).not.toContain("ALTER TYPE \"BrowserOperationKey\" ADD VALUE");
    expect(sql).toContain('CREATE TABLE public."AssistedCredentialMutation"');
    expect(sql).toContain('CREATE TABLE public."AssistedAccountState"');
    expect(sql).toContain('CONSTRAINT "AssistedCredentialMutation_pkey" PRIMARY KEY ("householdId","operationId")');
    expect(sql).toContain('UNIQUE ("browserBindingId")');
    expect(sql).toContain('UNIQUE ("attestationNonce")');
    expect(sql).toContain("octet_length(\"passwordHashDigest\")=32");
    expect(sql).toContain("octet_length(\"attestationNonce\")=32");
    expect(sql).toContain("octet_length(\"attestationMacDigest\")=32");
    expect(sql).toContain("'member.account.create'::public.\"BrowserOperationKey\"");
    expect(sql).toContain("'member.password.reset'::public.\"BrowserOperationKey\"");
    expect(sql).toContain('FOREIGN KEY ("targetUserId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE');
    expect(sql).toContain('FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE');
    expect(sql).not.toMatch(/FOREIGN KEY \("(householdId|browserBindingId|actorUserId|actorSessionId|actorMemberId|targetMemberId|accountId|assistedCreationHouseholdId|assistedCreationMemberId|assistedCreationOperationId)"\)/);
    for (const guard of [
      "AssistedCredentialMutation_immutable", "AssistedCredentialMutation_retention_truncate_guard",
      "AssistedAccountState_transition_guard", "AssistedAccountState_retention_truncate_guard"
    ]) expect(sql).toContain(`CREATE TRIGGER "${guard}"`);
    expect(sql).toContain("assisted_credential_mutation_immutable");
    expect(sql).toContain("assisted_account_state_origin_immutable");
    expect(sql).toContain("assisted_retention_delete_forbidden");
    expect(sql).toContain("WHEN 'member.account.create' THEN \"targetKind\"='household' AND \"targetId\" IS NULL AND \"babyId\" IS NULL");
    expect(sql).toContain("WHEN 'member.password.reset' THEN \"targetKind\"='member' AND \"targetId\" IS NOT NULL AND \"babyId\" IS NULL");
    expect(sql).not.toMatch(/session_replication_role|DISABLE\s+TRIGGER|set_config\s*\(|EXECUTE\s+format/i);
  });

  it("defines exact fixed-search-path procedures with PUBLIC closed and runtime execute-only grants", () => {
    const sql = readFileSync(persistenceMigrationUrl, "utf8");
    const signatures = [
      '"acquire_assisted_credential_fence_v1"()',
      '"lock_actor_session_for_assisted_operation_nowait"(TEXT,TEXT)',
      '"lock_user_sessions_for_assisted_operation_nowait"(TEXT)',
      '"lock_actor_session_for_browser_write_v1"(TEXT,TEXT)',
      '"create_assisted_member_account_v1"(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,public."HouseholdRole",TEXT,BYTEA,BOOLEAN,INTEGER,BYTEA,TIMESTAMP,BYTEA)',
      '"reset_assisted_member_password_v1"(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,INTEGER,TEXT,BYTEA,BOOLEAN,INTEGER,BYTEA,TIMESTAMP,BYTEA)',
      '"get_assisted_account_operation_status_v1"(TEXT,TEXT,TEXT,TEXT)',
      '"sign_out_required_change_session_v1"(TEXT,TEXT)'
    ];
    for (const signature of signatures) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC;`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO cubby_runtime;`);
    }
    for (const name of [
      "acquire_assisted_credential_fence_v1", "lock_actor_session_for_assisted_operation_nowait",
      "lock_user_sessions_for_assisted_operation_nowait", "lock_actor_session_for_browser_write_v1",
      "create_assisted_member_account_v1", "reset_assisted_member_password_v1",
      "get_assisted_account_operation_status_v1", "sign_out_required_change_session_v1"
    ]) {
      const body = sqlFunction(sql, name);
      expect(body).toContain("SECURITY DEFINER");
      expect(body).toContain("SET search_path=pg_catalog,public");
      expect(body).not.toMatch(/EXECUTE\s+format|EXECUTE\s+scope/i);
    }
    expect(sql).toContain('GRANT SELECT ON TABLE public."AssistedAccountState" TO cubby_runtime;');
    expect(sql).toContain('REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON TABLE public."AssistedAccountState" FROM cubby_runtime;');
    expect(sql).toContain('REVOKE ALL ON TABLE public."AssistedCredentialMutation" FROM cubby_runtime;');
    expect(sql).not.toMatch(/GRANT (SELECT|INSERT|UPDATE|DELETE).*public\."(User|Account|Session|FreshAuthAttestationKey)"/);
  });

  it("enforces the nonblocking fence and reviewed lock order in both create and reset", () => {
    const sql = readFileSync(persistenceMigrationUrl, "utf8");
    const fence = sqlFunction(sql, "acquire_assisted_credential_fence_v1");
    expect(fence).toContain("pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0))");
    expect(fence).toContain('LOCK TABLE public."HouseholdMember" IN EXCLUSIVE MODE NOWAIT');

    const lockOrder = [
      'public."acquire_assisted_credential_fence_v1"()',
      'FROM public."PlatformAuthority" WHERE "id"=\'platform\' FOR SHARE NOWAIT',
      'FROM public."PlatformSettings" WHERE "id"=\'platform\' FOR SHARE NOWAIT',
      'FROM public."User" WHERE "id" IN',
      'FROM public."AccountSecurityState" WHERE "userId" IN',
      'FROM public."Account" WHERE "userId" IN',
      'public."lock_actor_session_for_assisted_operation_nowait"',
      'FROM public."SessionSecurityActivity" WHERE "userId" IN',
      'FROM public."FreshAuthGrant" WHERE "userId" IN',
      'FROM public."RecoverySession" WHERE "userId"',
      'FROM public."GlobalSecurityOperationBinding" WHERE "userId"',
      'FROM public."GlobalSecurityOperation" WHERE "userId"',
      'PERFORM 1 FROM public."HouseholdMember"',
      'FROM public."Household" WHERE "id"',
      'public."try_lock_assisted_browser_identity_v1"',
      'INTO binding_row FROM public."BrowserOperationBinding"'
    ];
    for (const procedure of ["create_assisted_member_account_v1", "reset_assisted_member_password_v1"]) {
      const body = sqlFunction(sql, procedure);
      indexOrder(body, lockOrder);
      expect(body).not.toContain("pg_advisory_xact_lock((('x'");
      expect(body).not.toMatch(/FOR (?:UPDATE|SHARE|KEY SHARE)(?!\s+NOWAIT)/);
    }
    const tryLock = sqlFunction(sql, "try_lock_assisted_browser_identity_v1");
    expect(tryLock).toContain("pg_try_advisory_xact_lock");
    expect(tryLock).toContain("ERRCODE='55P03'");
  });

  it("rechecks actor hierarchy, protected targets, foreign membership, and exact create semantics in SQL", () => {
    const sql = readFileSync(persistenceMigrationUrl, "utf8");
    const create = sqlFunction(sql, "create_assisted_member_account_v1");
    const reset = sqlFunction(sql, "reset_assisted_member_password_v1");
    for (const body of [create, reset]) {
      expect(body).toContain("INTERVAL '10 minutes'");
      expect(body).not.toMatch(/UPDATE public\."BrowserOperationBinding" SET "intentFingerprint"/);
      expect(body).toContain('scope_opening_fingerprint,scope_intent_fingerprint,2');
      expect(body).toContain('actor_member."disabledAt" IS NOT NULL');
      expect(body).toContain('actor_member."deletedAt" IS NOT NULL');
    }
    expect(create).toContain("actor_member.\"role\"='owner'");
    expect(create).toContain("actor_member.\"role\"='admin'");
    expect(reset).toContain("actor_member.\"role\" NOT IN ('owner','admin')");
    expect(reset).toContain("actor_member.\"role\"='admin'");
    expect(reset).toContain('platform_authority."ownerUserId"');
    expect(create).toContain('lower(btrim(scope_email))');
    expect(create).toContain("existing_account_invitation_required");
    expect(create).toContain('"emailVerified"');
    expect(create).toContain("false");
    expect(create).toContain('invitation_protocol."InvitationAccountSetup"');
    expect(reset).toContain('foreign_member."deletedAt" IS NULL');
    expect(reset).not.toContain('foreign_member."disabledAt"');
    expect(reset).not.toContain('foreign_household."deletedAt"');
    expect(reset).toContain("personal_recovery_unavailable");
    expect(reset).toContain('target_user."id"=actor_session."userId"');
    for (const body of [create, reset]) expect(body).toContain('actor_security."userId" IS NULL');
    const browserWriteLock = sqlFunction(sql, "lock_actor_session_for_browser_write_v1");
    expect(browserWriteLock).toContain('security_state."userId" IS NULL');
  });

  it("verifies the purpose-separated binary HMAC frame and digests in each mutation", () => {
    const sql = readFileSync(persistenceMigrationUrl, "utf8");
    for (const [procedure, purpose] of [
      ["create_assisted_member_account_v1", "member_account_create"],
      ["reset_assisted_member_password_v1", "member_password_reset"]
    ] as const) {
      const body = sqlFunction(sql, procedure);
      expect(body).toContain("cubby.admin-assisted-credential-mutation.v1");
      expect(body).toContain(purpose);
      expect(body).toContain("int4send(octet_length(");
      expect(body).toContain("int8send(");
      expect(body).toContain("timestamp_send(scope_attestation_issued_at)");
      expect(body).toContain("digest(convert_to(scope_replacement_password_hash,'UTF8'),'sha256')");
      expect(body).toContain("public.hmac(attestation_frame,key_row.\"verificationKey\",'sha256')");
      expect(body).toContain('public."credential_proof_constant_time_equal_v1"');
      expect(body).toContain("INTERVAL '5 seconds'");
      expect(body).toContain("INTERVAL '10 minutes'");
      // Provisioning leaves the prior row active during overlap; active alone is insufficient.
      expect(body).toContain('key_row."active" IS NOT TRUE');
      expect(body).toContain('key_row."rotatedAt"<=clock_timestamp()-INTERVAL \'10 minutes\'');
      expect(body).not.toContain('key_row."active" IS NOT TRUE AND');
      expect(body).toContain("scope_attestation_issued_at IS NULL");
      expect(body).toContain("scope_attestation_key_version IS NULL");
    }
  });

  it("implements required-change rebind/clear closure without inventing a self-change hash receipt", () => {
    const sql = readFileSync(persistenceMigrationUrl, "utf8");
    const accountGuard = sqlFunction(sql, "enforce_account_security_version_transition");
    const stateGuard = sqlFunction(sql, "enforce_assisted_account_state_transition_v1");
    expect(accountGuard).toContain('"requiredChangeCredentialVersion"=NEW."credentialVersion"');
    expect(stateGuard).toContain('public."PasswordChangeCredentialMutation"');
    expect(stateGuard).toContain('operation_row."operationKey"=\'password_change\'');
    expect(stateGuard).toContain('operation_row."status"=\'completed\'');
    expect(stateGuard).toContain('operation_row."outcomeCode"=\'changed\'');
    expect(stateGuard).toContain('binding_row."state"=\'terminal\'');
    expect(stateGuard).not.toMatch(/PasswordChangeCredentialMutation[^;]*passwordHash|receipt_hash/i);
    expect(sql).toContain('requiredChangeCredentialVersion" IS NOT NULL');
  });

  it("closes every reset carrier through its own legal stale lifecycle and revokes sessions and grants", () => {
    const sql = readFileSync(persistenceMigrationUrl, "utf8");
    const reset = sqlFunction(sql, "reset_assisted_member_password_v1");
    indexOrder(reset, [
      'UPDATE public."AccountSecurityState"',
      'UPDATE public."GlobalSecurityOperation"',
      "'stale_security_version'",
      'UPDATE public."GlobalSecurityOperationBinding"',
      'UPDATE public."RecoverySession"',
      'INSERT INTO public."GlobalSecurityEvent"'
    ]);
    expect(reset).toContain('DELETE FROM public."Session"');
    expect(reset).toContain('UPDATE public."SessionSecurityActivity" SET "state"=\'revoked\'');
    expect(reset).toContain('UPDATE public."FreshAuthGrant" SET "state"=\'revoked\'');
    expect(reset).not.toMatch(/UPDATE public\."RecoveryCode"|DELETE FROM public\."RecoveryCode"/);
    expect(reset).toContain("'operation_outcome'");
    expect(reset).toContain("'{}'::jsonb");
    expect(reset).toContain('"outcomeCode"=\'stale_security_version\',"outcomeSnapshot"=\'{}\'::jsonb');
  });

  it("installs bidirectional deferred closure and preserves receipts through exact compaction handoff", () => {
    const sql = readFileSync(persistenceMigrationUrl, "utf8");
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER "AssistedCredentialMutation_success_closure"');
    expect(sql).toContain("AFTER INSERT ON public.\"AssistedCredentialMutation\" DEFERRABLE INITIALLY DEFERRED");
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER "BrowserMutationOperation_assisted_receipt_closure"');
    expect(sql).toContain("AFTER INSERT OR UPDATE ON public.\"BrowserMutationOperation\" DEFERRABLE INITIALLY DEFERRED");
    const closure = sqlFunction(sql, "assert_assisted_credential_mutation_success_v1");
    for (const evidence of [
      "browserBindingId", "actorUserId", "actorSessionId", "actorMemberId", "targetUserId", "targetMemberId",
      "accountId", "openingFingerprint", "intentFingerprint", "requireFirstLoginPasswordChange",
      "lastCredentialOperationId", "lastSessionSecurityOperationId", "passwordHashDigest"
    ]) expect(closure).toContain(`"${evidence}"`);
    expect(closure).toContain('binding_row."openingFingerprint" IS DISTINCT FROM receipt."openingFingerprint"');
    expect(closure).toContain('binding_row."intentFingerprint" IS NOT NULL');
    expect(closure).toContain('operation_row."intentFingerprint" IS DISTINCT FROM receipt."intentFingerprint"');
    expect(closure).toContain('binding_row."persistenceVersion"<>2');
    expect(closure).toContain('binding_row."protocolVersion"<>\'browser_v2\'');
    expect(closure).toContain('operation_row."auditCorrelation" IS DISTINCT FROM receipt."operationId"');
    expect(closure).toContain('security_state."userId" IS NULL');
    expect(closure).toContain('assisted_state."userId" IS NULL');
    expect(closure).toContain('operation_row."outcomeSnapshot" IS DISTINCT FROM');
    expect(closure).toContain('binding_row."targetSnapshot"->>\'targetUserId\' IS DISTINCT FROM receipt."targetUserId"');
    expect(closure).toMatch(/count\(\*\)\s+INTO\s+audit_count\s+FROM public\."AuditEvent"/);
    expect(closure).toContain("'{}'::jsonb");
    expect(closure).toContain('EXISTS (SELECT 1 FROM public."Session"');
    expect(closure).toContain('EXISTS (SELECT 1 FROM public."RecoverySession"');

    const compactor = sqlFunction(sql, "compact_household_browser_operation");
    expect(compactor).toContain('INSERT INTO public."BrowserMutationOperationTombstone"');
    expect(compactor).toContain('public."AssistedCredentialMutation" receipt');
    expect(compactor).toContain('DELETE FROM public."BrowserMutationOperation"');
    expect(compactor).toContain('DELETE FROM public."BrowserOperationBinding"');
    expect(compactor).not.toMatch(/DELETE FROM public\."AssistedCredentialMutation"/);
    indexOrder(compactor, [
      'INSERT INTO public."BrowserMutationOperationTombstone"',
      'public."AssistedCredentialMutation" receipt',
      'DELETE FROM public."BrowserMutationOperation"',
      'DELETE FROM public."BrowserOperationBinding"'
    ]);
  });

  it("keeps historical status independent of current target hash/version/session state and signs out only the matching restricted session", () => {
    const sql = readFileSync(persistenceMigrationUrl, "utf8");
    const status = sqlFunction(sql, "get_assisted_account_operation_status_v1");
    expect(status).toContain('public."AssistedCredentialMutation"');
    expect(status).toContain('public."BrowserMutationOperationTombstone"');
    expect(status).toContain('binding_row."targetSnapshot"->>\'targetUserId\'');
    expect(status).toContain('binding_row."targetSnapshot"->>\'targetMemberId\'');
    expect(status).toContain('actor_activity."state"<>\'active\'');
    expect(status).toContain('actor_activity."issuanceSessionSecurityVersion"<>actor_security."sessionSecurityVersion"');
    expect(status).toContain('actor_assisted."requiredChangeCredentialVersion" IS NOT NULL');
    expect(status).toContain('household_row."deletedAt" IS NOT NULL');
    expect(status).toContain('invitation_protocol."InvitationAccountSetup"');
    expect(status).not.toContain('public."lock_actor_session_for_assisted_operation_nowait"');
    expect(status).toContain('actor_session."expiresAt"<=clock_timestamp()');
    expect(status).toContain('original_session_id IS DISTINCT FROM scope_actor_session_id');
    expect(status).not.toContain("INTERVAL '10 minutes'");
    expect(status).not.toMatch(/"password"|passwordHashDigest|target_security|receipt\."newCredentialVersion"|FROM public\."Session" target_session/);
    const signOut = sqlFunction(sql, "sign_out_required_change_session_v1");
    expect(signOut).toContain('DELETE FROM public."Session" WHERE "id"=scope_session_id AND "userId"=scope_user_id');
    expect(signOut).toContain('state_row."requiredChangeCredentialVersion" IS NULL THEN RETURN false');
    expect(signOut).not.toMatch(/DELETE FROM public\."Session" WHERE "userId"=scope_user_id(?! AND)/);
    expect(signOut).not.toContain('INSERT INTO public."GlobalSecurityOperation"');
  });

  it("permits retained operation compaction after the sole authorized receipt cascade, not arbitrary missing evidence", () => {
    const sql = readFileSync(persistenceMigrationUrl, "utf8");
    const compactor = sqlFunction(sql, "compact_household_browser_operation");
    const receiptGuard = sqlFunction(sql, "prevent_assisted_credential_mutation_change_v1");
    expect(receiptGuard).toContain('TG_OP=\'DELETE\' AND NOT EXISTS (SELECT 1 FROM public."User" WHERE "id"=OLD."targetUserId")');
    expect(compactor).toContain("assisted_compaction_target_deletion_unproven");
    expect(compactor).toContain('FROM public."HouseholdMember" surviving_target');
    expect(compactor).toContain('FROM public."User" surviving_target');
    expect(compactor).toContain('full_operation."outcomeSnapshot" IS DISTINCT FROM jsonb_build_object');
    expect(compactor).toContain('full_operation."persistenceVersion"<>2');
    expect(compactor).toContain('bound."state"<>\'terminal\'');
    // The completed-operation converse and receipt deletion guard remain mandatory.
    expect(sql).toContain('CREATE CONSTRAINT TRIGGER "BrowserMutationOperation_assisted_receipt_closure"');
    expect(compactor).not.toMatch(/DISABLE|set_config|session_replication_role/i);
  });
});
