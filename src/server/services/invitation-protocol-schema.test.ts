import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schemaPath = fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url));
const migrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260904120000_invitation_protocol_v2/migration.sql", import.meta.url));

const procedures = [
  "claim_invitation_presentation_v2", "close_invitation_presentation_v2", "reserve_manual_invite_create_v2", "submit_manual_invite_create_v2",
  "status_manual_invite_create_v2", "abandon_manual_invite_create_v2", "reserve_manual_invite_replace_v2", "submit_manual_invite_replace_v2",
  "status_manual_invite_replace_v2", "abandon_manual_invite_replace_v2", "reserve_invitation_credential_setup_v2", "submit_invitation_credential_setup_v2",
  "status_invitation_credential_setup_v2", "abandon_invitation_credential_setup_v2", "reserve_invitation_recovery_enrollment_v2", "submit_invitation_recovery_enrollment_v2",
  "status_invitation_recovery_enrollment_v2", "abandon_invitation_recovery_enrollment_v2", "reserve_invitation_recovery_rehearsal_v2", "submit_invitation_recovery_rehearsal_v2",
  "status_invitation_recovery_rehearsal_v2", "abandon_invitation_recovery_rehearsal_v2", "bind_post_signin_invitation_claim_v2", "issue_invitation_review_v2",
  "reserve_invitation_acceptance_v2", "submit_invitation_acceptance_v2", "status_invitation_acceptance_v2", "abandon_invitation_acceptance_v2",
  "revoke_invitation_v2", "revoke_all_invitations_v2", "expire_invitation_v2", "compact_invitation_operation_v2",
  "classify_invitation_setup_corridor_v2", "write_invitation_audit_v2"
];

function procedureBody(migration: string, name: string) {
  const expression = new RegExp(
    `CREATE OR REPLACE FUNCTION invitation_protocol\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
    "g",
  );
  const matches = [...migration.matchAll(expression)];
  const match = matches.at(-1);
  expect(match, `missing body for ${name}`).not.toBeNull();
  return match?.[1] ?? "";
}

const lifecycleProcedures = procedures.filter((name) => name !== "write_invitation_audit_v2");
const lockingProcedures = ["classify_invitation_setup_corridor_v2"] as const;
const reservationProcedures = procedures.filter((name) => name.startsWith("reserve_"));
const submitProcedures = procedures.filter((name) => name.startsWith("submit_"));
const statusProcedures = procedures.filter((name) => name.startsWith("status_"));
const abandonmentProcedures = procedures.filter((name) => name.startsWith("abandon_"));

const grantedProcedureSignatures = [
  "expire_invitation_v2(TEXT,TIMESTAMPTZ,invitation_protocol.invitation_expiry_worker_carrier)",
  "classify_invitation_setup_corridor_v2(TEXT,invitation_protocol.invitation_setup_corridor_attestation)",
  "compact_invitation_operation_v2(UUID,invitation_protocol.invitation_maintenance_worker_carrier)",
];

describe("invitation protocol schema and guarded procedures", () => {
  it("verifies the issuance domain and persisted batch identity before terminal replay", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const carrier = procedureBody(migration, "reauthorize_invitation_carrier_v2");
    const submit = procedureBody(migration, "submit_invitation_recovery_enrollment_v2");
    expect(carrier.includes("cubby.invitation.recovery-enrollment-attestation.v1")).toBe(true);
    expect(submit.indexOf("verify_invitation_recovery_verifier_batch_v1") < submit.indexOf('IF identity_row."state"=\'TERMINAL_FULL\'')).toBe(true);
    expect(submit.includes('bridge_row."verifierBatchDigest" IS DISTINCT FROM verifier_batch_digest')).toBe(true);
  });

  it("creates the recovery set while the canonical grant is issued and consumes it before commit", () => {
    const submit = procedureBody(readFileSync(migrationPath, "utf8"), "submit_invitation_recovery_enrollment_v2");
    const create = submit.indexOf('INSERT INTO public."RecoveryCodeSet"');
    const consume = submit.indexOf('UPDATE public."FreshAuthGrant" SET "state"=\'consumed\'');
    expect(create >= 0 && consume > create).toBe(true);
    expect(consume < submit.indexOf("RETURN invitation_protocol.invitation_safe_receipt(operation_id,'generated','recovery_codes_generated')")).toBe(true);
  });

  it("schema-qualifies canonical Global Security enums under invitation-only search paths", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(/::"(?:GlobalSecurityOperationKey|GlobalSecurityOperationStatus|FreshAuthGrantState)"/.test(migration)).toBe(false);
  });

  it("schema-qualifies pgcrypto random-byte calls under fixed search paths", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).not.toMatch(/(?<!public\.)\bgen_random_bytes\(/);
    expect(migration).toContain("public.gen_random_bytes(");
  });

  it("grants the non-login protocol owner every explicit external capability used by guarded routines", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain("GRANT USAGE ON SCHEMA public TO invitation_protocol_owner_NOLOGIN;");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.gen_random_bytes(INTEGER),public.digest(BYTEA,TEXT),public.hmac(BYTEA,BYTEA,TEXT) TO invitation_protocol_owner_NOLOGIN;");
    expect(migration).toContain('GRANT SELECT,UPDATE ON public."Household",public."Session" TO invitation_protocol_owner_NOLOGIN;');
    expect(migration).toContain('GRANT SELECT,UPDATE ON public."FreshAuthAttestationKey" TO invitation_protocol_owner_NOLOGIN;');
    expect(migration).toContain('GRANT INSERT ON public."FreshAuthGrant",public."GlobalSecurityOperation",public."GlobalSecurityOperationBinding" TO invitation_protocol_owner_NOLOGIN;');
  });

  it("scopes audit-writer parameters away from target relation columns", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration).toContain("write_invitation_audit_v2(scope_household_id TEXT, scope_nullable_identity_id UUID, scope_action invitation_protocol.invitation_audit_action, scope_safe_projection JSONB, scope_helper_attestation invitation_protocol.invitation_owner_private_call_attestation)");
    const body = procedureBody(migration, "write_invitation_audit_v2");
    expect(body).toContain('WHERE "householdId"=scope_household_id');
    expect(body).toContain("scope_action::TEXT");
    expect(body).not.toMatch(/\baction::TEXT/);
  });

  it("assigns tombstone terminal states through the exact enum type", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const body = procedureBody(migration, "write_invitation_tombstone_v2");
    expect(body).toMatch(/\(CASE WHEN scope_class='FULL_COMPACTION' THEN 'COMPACTED' WHEN scope_identity\."operationKind"='PRESENTATION_CLAIM' THEN 'PRESENTATION_CLOSED' ELSE 'ABANDONED' END\)::invitation_protocol\."InvitationOperationState"/);
  });

  it("executes lineage row-lock probes without producing an unconsumed result set", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration.match(/PERFORM 1 FROM invitation_protocol\."InvitationLineage"[^;]+FOR UPDATE;/g)).toHaveLength(2);
    expect(migration).not.toMatch(/(?:^|\n)\s*SELECT 1 FROM invitation_protocol\."InvitationLineage"[^;]+FOR UPDATE;/);
  });

  it("schema-qualifies every pgcrypto call used under a fixed search path", () => {
    const migration = readFileSync(migrationPath, "utf8");
    expect(migration.match(/(?<![.\w])(digest|hmac|gen_random_bytes)\s*\(/g) ?? []).toEqual([]);
  });

  it("declares the protocol state, retained peers, challenge, and exactly 34 fixed-search-path procedures", () => {
    const schema = readFileSync(schemaPath, "utf8");
    const migration = readFileSync(migrationPath, "utf8");

    expect(schema).toContain("enum InvitationOperationKind");
    expect(schema).toContain("PRESENTATION_CLAIM");
    expect(schema).toContain("INVITE_REVOKE_ALL");
    for (const model of ["InvitationLineage", "InvitationOperationIdentity", "InvitationPresentationClaim", "InvitationOperationBinding", "InvitationOperationResult", "InvitationOperationTombstone", "InvitationAccountSetup", "InvitationRecoveryRehearsalChallenge"]) {
      expect(schema).toContain(`model ${model}`);
    }
    expect(migration).toContain('CREATE SCHEMA IF NOT EXISTS invitation_protocol');
    expect(migration).toMatch(/CREATE TYPE invitation_protocol\.invitation_audit_action AS ENUM \([^;]*'invitation\.operation\.compact'[^;]*\);/s);
    expect(migration).not.toContain("invitation.household.contain");
    expect(migration).not.toContain("ALTER TYPE invitation_protocol.invitation_audit_action ADD VALUE");
    expect(migration).toContain('SET search_path=pg_catalog,invitation_protocol');
    expect(migration).toContain('InvitationOperationIdentity_occupancy_guard');
    expect(migration).toContain('InvitationProcedureTransitionBinding');
    expect(migration).toContain('InvitationRecoveryRehearsalChallenge_binding_guard');
    expect(migration).toContain('verify_invitation_recovery_rehearsal_attestation_v1');
    expect(migration).toContain("invitation-recovery-rehearsal-attestation-v1");
    expect(migration).toContain('ON DELETE SET NULL');
    expect(migration).toContain("runtime_procedures TEXT[]");
    expect(migration).toContain("cubby_invitation_expiry_worker");
    expect(migration).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA invitation_protocol FROM PUBLIC');
    expect(migration).toContain('public."FreshAuthAttestationKey",public."RecoveryCodeSet",public."RecoveryCode"');
    expect(procedures.filter((name) => migration.includes(`FUNCTION invitation_protocol.${name}`))).toHaveLength(34);
    expect(procedures.filter((name) => migration.includes(`('${name}'`))).toHaveLength(34);
    for (const name of procedures) {
      expect(migration).toMatch(new RegExp(`FUNCTION invitation_protocol\\.${name}[^$]+SET search_path=pg_catalog,invitation_protocol`));
    }
  });

  it("does not retain legacy bare-operation procedure overloads", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const forbiddenSignatures = [
      "status_invitation_acceptance_v2(operation_id UUID)",
      "abandon_invitation_acceptance_v2(operation_id UUID)",
      "compact_invitation_operation_v2(identity_id UUID)",
      "delete_household_with_invitation_containment_v2(household_id TEXT, authorized_delete_operation_id UUID)",
    ];

    for (const signature of forbiddenSignatures) {
      expect(migration, signature).not.toContain(`FUNCTION invitation_protocol.${signature}`);
    }
  });

  it("takes the canonical operation-then-household advisory locks before its first row lock", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const lock = procedureBody(migration, "lock_invitation_protocol_v2");
    expect(lock.indexOf("scope_operation_id::TEXT")).toBeLessThan(lock.indexOf("scope_household_id"));

    for (const name of lockingProcedures) {
      const body = procedureBody(migration, name);
      const firstAdvisory = Math.min(
        ...["lock_invitation_protocol_v2", "lock_invitation_operation_v2", "lock_invitation_claim_v2"].map((lockName) => {
          const index = body.indexOf(lockName);
          return index === -1 ? Number.MAX_SAFE_INTEGER : index;
        }),
      );
      expect(firstAdvisory, `${name} takes the shared advisory chain`).toBeLessThan(Number.MAX_SAFE_INTEGER);
      expect(firstAdvisory, `${name} takes advisory locks before row locks`).toBeLessThan(body.indexOf("FOR UPDATE"));
    }
  });

  it("defers household deletion fail closed and retains no containment authority surface", () => {
    const migration = readFileSync(migrationPath, "utf8");
    for (const forbidden of [
      "InvitationHouseholdDeleteAuthorization", "invitation_household_delete_authorization",
      "delete_household_with_invitation_containment_v2", "issue_invitation_household_delete_authorization_v2",
      "cubby_household_delete_runtime", "HOUSEHOLD_DELETE_DATABASE_URL", "invitation.household.contain",
    ]) expect(migration).not.toContain(forbidden);
    expect(migration).toContain("household_deletion_deferred_fail_closed");
  });

  it("keeps every runtime sibling on an exact signature and minimal grant", () => {
    const migration = readFileSync(migrationPath, "utf8");
    for (const name of procedures) {
      expect(migration).toMatch(new RegExp(`FUNCTION invitation_protocol\\.${name}\\([^;]+?\\) RETURNS`));
    }
    for (const signature of grantedProcedureSignatures) {
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION invitation_protocol.${signature}`);
    }
    expect(migration).not.toContain("GRANT EXECUTE ON FUNCTION invitation_protocol.issue_invitation_household_delete_authorization_v2");
  });

  it("preserves the established global runtime and auth relation grants", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const publicRelationDenial = migration.match(
      /-- Direct public-relation denial is scoped to the execute-only invitation roles\.([\s\S]*?)-- Invitation-schema execution remains denied by default for every login role\./,
    )?.[1];
    expect(publicRelationDenial).toBeDefined();
    for (const role of [
      "cubby_invitation_runtime",
      "cubby_invitation_expiry_worker",
      "cubby_invitation_maintenance_worker",
    ]) expect(publicRelationDenial).toContain(`'${role}'`);
    for (const establishedRole of [
      "cubby_runtime",
      "cubby_auth",
      "cubby_email_delivery",
      "cubby_security_operator",
    ]) expect(publicRelationDenial).not.toContain(`'${establishedRole}'`);
  });

  it("rejects placeholder bodies and requires the reviewed guarded-transition contract", () => {
    const migration = readFileSync(migrationPath, "utf8");

    for (const name of procedures) {
      const body = procedureBody(migration, name);
      expect(body.length, `${name} must have a substantive body`).toBeGreaterThan(320);
    }

    for (const name of lifecycleProcedures) {
      const body = procedureBody(migration, name);
      expect(body, `${name} lock chain`).toContain("lock_invitation_protocol_v2");
      expect(body, `${name} carrier authority`).toContain(
        name === "claim_invitation_presentation_v2"
          ? "reauthorize_invitation_public_claim_carrier_v2"
          : name === "expire_invitation_v2"
            ? "worker_attestation).invite_id"
            : name === "compact_invitation_operation_v2"
              ? "worker_attestation).identity_id"
              : name === "reserve_invitation_credential_setup_v2" || name === "submit_invitation_credential_setup_v2"
              ? "verify_invitation_preaccount_credential_attestation_v1"
              : name === "status_invitation_credential_setup_v2" || name === "abandon_invitation_credential_setup_v2"
                ? "verify_invitation_credential_status_attestation_v1"
            : name === "classify_invitation_setup_corridor_v2"
              ? "InvitationSetupCorridorAttestationReceipt"
              : "reauthorize_invitation_carrier_v2",
      );
    }

    for (const name of reservationProcedures) {
      const body = procedureBody(migration, name);
      expect(body, `${name} identity`).toContain("create_invitation_identity_v2");
      expect(body, `${name} binding`).toContain("write_invitation_binding_v2");
    }

    for (const name of submitProcedures) {
      const body = procedureBody(migration, name);
      expect(body, `${name} terminal result`).toContain("write_invitation_terminal_result_v2");
      expect(body, `${name} audit`).toContain("write_invitation_audit_v2");
      expect(body, `${name} domain transition`).toContain("execute_invitation_domain_transition_v2");
    }

    for (const name of statusProcedures) {
      expect(procedureBody(migration, name), `${name} result read`).toContain('InvitationOperationResult');
    }

    for (const name of abandonmentProcedures) {
      const body = procedureBody(migration, name);
      expect(body, `${name} tombstone`).toContain("write_invitation_tombstone_v2");
      expect(body, `${name} audit`).toContain("write_invitation_audit_v2");
    }

    for (const name of ["claim_invitation_presentation_v2", "close_invitation_presentation_v2", "bind_post_signin_invitation_claim_v2", "issue_invitation_review_v2", "expire_invitation_v2"]) {
      const body = procedureBody(migration, name);
      expect(body, `${name} claim state`).toContain('InvitationPresentationClaim');
      expect(body, `${name} identity state`).toContain('InvitationOperationIdentity');
    }

    const claim = procedureBody(migration, "claim_invitation_presentation_v2");
    expect(migration).toMatch(/claim_invitation_presentation_v2\(raw_fragment_token TEXT, browser_partition_digest BYTEA, public_claim_attestation invitation_protocol\.invitation_public_token_claim\)/);
    for (const required of [
      'public_claim_attestation).token_hash_digest<>token_digest',
      'reauthorize_invitation_public_claim_carrier_v2',
      'browserPartitionDigest',
      'tokenHashDigest',
      'public."Invite"',
      '"tokenHash"=encode(token_digest,\'hex\')',
      '"status"=\'pending\'',
      '"expiresAt">clock_timestamp()',
      'FOR UPDATE',
      "lock_invitation_protocol_v2",
      "create_invitation_identity_v2",
      "PRESENTATION_OPEN",
      "invitation_claim_denied",
    ]) {
      expect(claim, `claim carrier and live-token guard ${required}`).toContain(required);
    }
    expect(claim).toMatch(/jsonb_build_object\([^;]*(?:'status','(?:claimed|unavailable)'|'outcome','(?:claimed|unavailable)')/);

    const close = procedureBody(migration, "close_invitation_presentation_v2");
    expect(migration).toMatch(/close_invitation_presentation_v2\(claim_identity_id UUID, reason invitation_protocol\.presentation_close_reason, request_attestation invitation_protocol\.invitation_request_attestation\)/);
    for (const required of [
      'InvitationPresentationClaim',
      'InvitationOperationIdentity',
      'PRESENTATION_CLAIM',
      'FOR UPDATE',
      'lock_invitation_protocol_v2',
      'reauthorize_invitation_carrier_v2',
      'DELETE FROM invitation_protocol."InvitationPresentationClaim"',
      "write_invitation_tombstone_v2",
      "'RESERVATION_CLOSE'",
      "write_invitation_audit_v2",
      "'invite.close'",
    ]) {
      expect(close, `close claim transition ${required}`).toContain(required);
    }
    expect(close).toMatch(/PRESENTATION_(?:OPEN|SUBJECT_BOUND)/);

    const bind = procedureBody(migration, "bind_post_signin_invitation_claim_v2");
    expect(migration).toMatch(/bind_post_signin_invitation_claim_v2\(session_id TEXT, claim_identity_id UUID, request_attestation invitation_protocol\.invitation_request_attestation\)/);
    for (const required of [
      'InvitationPresentationClaim',
      'InvitationOperationIdentity',
      'public."Session"',
      'public."User"',
      'public."Invite"',
      'InvitationLineage',
      '"email"',
      'FOR UPDATE',
      'lock_invitation_protocol_v2',
      'reauthorize_invitation_carrier_v2',
      '"subjectUserId"',
      '"subjectRole"',
      'PRESENTATION_SUBJECT_BOUND',
      'invitation_bind_denied',
    ]) {
      expect(bind, `post-sign-in bind recheck ${required}`).toContain(required);
    }
    expect(bind).toMatch(/UPDATE invitation_protocol\."InvitationPresentationClaim"[\s\S]*"subjectUserId"/);
    expect(bind).toMatch(/UPDATE invitation_protocol\."InvitationOperationIdentity"[\s\S]*"subjectRole"/);
    expect(bind).toMatch(/jsonb_build_object\([^;]*(?:'status','(?:review|unavailable)'|'outcome','(?:review|unavailable)')/);

    const review = procedureBody(migration, "issue_invitation_review_v2");
    const reviewSnapshot = procedureBody(migration, "recompute_invitation_review_snapshot_v2");
    expect(migration).toMatch(/issue_invitation_review_v2\(claim_identity_id UUID, session_id TEXT, request_attestation invitation_protocol\.invitation_request_attestation\)/);
    for (const required of [
      'InvitationPresentationClaim',
      'InvitationOperationIdentity',
      'InvitationLineage',
      'public."Invite"',
      'public."Session"',
      'public."User"',
      'FOR UPDATE',
      'lock_invitation_protocol_v2',
      'reauthorize_invitation_carrier_v2',
      'PRESENTATION_SUBJECT_BOUND',
      'recompute_invitation_review_snapshot_v2',
      'invitation_review_unavailable',
    ]) {
      expect(review, `review carrier/no-store contract ${required}`).toContain(required);
    }
    for (const required of [
      'reviewVersion',
      'reviewSnapshotDigest',
      'invitation-review-copy-v2',
      'household_name',
      'recovery_signin_boundary',
      'no_store',
    ]) {
      expect(reviewSnapshot, `review snapshot contract ${required}`).toContain(required);
    }
    expect(reviewSnapshot).toMatch(/jsonb_build_object\([^;]*'household_name'[^;]*'recovery_signin_boundary'/);
    expect(review).not.toContain('INSERT INTO invitation_protocol');
    expect(review).not.toContain('UPDATE invitation_protocol');
    expect(review).not.toContain('DELETE FROM invitation_protocol');

    const expiry = procedureBody(migration, "expire_invitation_v2");
    expect(migration).toMatch(/expire_invitation_v2\(invite_id TEXT, database_clock_guard TIMESTAMPTZ, worker_attestation invitation_protocol\.invitation_expiry_worker_carrier\)/);
    for (const required of [
      'worker_attestation).invite_id<>invite_id',
      'worker_attestation).issued_at',
      'InvitationPresentationClaim',
      'InvitationOperationIdentity',
      'public."Invite"',
      '"status"=\'expired\'',
      '"tokenVersion"',
      'FOR UPDATE',
      'lock_invitation_protocol_v2',
      'write_invitation_tombstone_v2',
      "'expiry'",
      'write_invitation_audit_v2',
      "'invite.expire'",
      'invitation_expiry_denied',
    ]) {
      expect(expiry, `expiry worker/claim closure ${required}`).toContain(required);
    }
    expect(expiry).toMatch(/IF NOT FOUND THEN RETURN;/);
    expect(expiry).toMatch(/UPDATE public\."Invite"[\s\S]*"status"='expired'/);

    for (const name of ["revoke_invitation_v2", "revoke_all_invitations_v2"]) {
      const body = procedureBody(migration, name);
      expect(body).toContain('InvitationOperationIdentity');
      expect(body).toContain('InvitationOperationBinding');
      expect(body).toContain('InvitationOperationResult');
      expect(body).toContain('UPDATE public."Invite"');
      expect(body).toContain("write_invitation_audit_v2");
    }

    const rehearsalReserve = procedureBody(migration, "reserve_invitation_recovery_rehearsal_v2");
    expect(rehearsalReserve).toContain('InvitationRecoveryRehearsalChallenge');
    expect(rehearsalReserve).toContain('RecoveryCodeSet');
    expect(rehearsalReserve).toContain('RecoveryCode');
    expect(rehearsalReserve).toContain("gen_random_bytes(32)");
    expect(rehearsalReserve).toContain("INTERVAL '10 minutes'");

    const rehearsalSubmit = procedureBody(migration, "submit_invitation_recovery_rehearsal_v2");
    for (const required of ["verify_invitation_recovery_rehearsal_attestation_v1", 'InvitationRecoveryRehearsalChallenge', 'FreshAuthAttestationKey', 'RecoveryCodeSet', 'RecoveryCode', "execute_invitation_domain_transition_v2", "remainingActiveCount"]) {
      expect(rehearsalSubmit, `rehearsal submit ${required}`).toContain(required);
    }
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("InvitationOperationTombstone");
    expect(migration).toContain("InvitationOperationResult");
  });

  it("makes the invitation presentation claim vertical slice route-specific", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const claim = procedureBody(migration, "claim_invitation_presentation_v2");
    const close = procedureBody(migration, "close_invitation_presentation_v2");
    const bind = procedureBody(migration, "bind_post_signin_invitation_claim_v2");
    const review = procedureBody(migration, "issue_invitation_review_v2");
    const reviewSnapshot = procedureBody(migration, "recompute_invitation_review_snapshot_v2");
    const expiry = procedureBody(migration, "expire_invitation_v2");

    expect(migration).toMatch(/claim_invitation_presentation_v2\(raw_fragment_token TEXT, browser_partition_digest BYTEA, public_claim_attestation invitation_protocol\.invitation_public_token_claim\)/);
    expect(migration).toMatch(/bind_post_signin_invitation_claim_v2\(session_id TEXT, claim_identity_id UUID, request_attestation invitation_protocol\.invitation_request_attestation\)/);
    expect(migration).toMatch(/issue_invitation_review_v2\(claim_identity_id UUID, session_id TEXT, request_attestation invitation_protocol\.invitation_request_attestation\)/);
    expect(migration).toMatch(/expire_invitation_v2\(invite_id TEXT, database_clock_guard TIMESTAMPTZ, worker_attestation invitation_protocol\.invitation_expiry_worker_carrier\)/);

    for (const required of [
      'public_claim_attestation).token_hash_digest<>token_digest', 'reauthorize_invitation_public_claim_carrier_v2', '"tokenHash"=encode(token_digest,\'hex\')', '"status"=\'pending\'', '"expiresAt">clock_timestamp()', 'browserPartitionDigest', 'tokenHashDigest', 'InvitationLineage', 'FOR UPDATE', 'PRESENTATION_OPEN', 'invitation_claim_denied',
    ]) expect(claim, `claim ${required}`).toContain(required);

    for (const required of [
      'InvitationPresentationClaim', 'InvitationOperationIdentity', 'InvitationLineage', 'public."Invite"', 'public."Session"', 'public."User"', 'PRESENTATION_OPEN', 'PRESENTATION_SUBJECT_BOUND', 'reauthorize_invitation_carrier_v2', 'write_invitation_tombstone_v2', "'RESERVATION_CLOSE'", 'write_invitation_audit_v2', "'invite.close'", 'DELETE FROM invitation_protocol."InvitationPresentationClaim"',
    ]) expect(close, `close ${required}`).toContain(required);

    for (const required of [
      'InvitationPresentationClaim', 'InvitationOperationIdentity', 'InvitationLineage', 'InvitationAccountSetup', 'public."Invite"', 'public."Session"', 'public."User"', '"email"', 'reauthorize_invitation_carrier_v2', '"subjectUserId"', '"subjectRole"', 'PRESENTATION_SUBJECT_BOUND', 'invitation_bind_denied',
    ]) expect(bind, `bind ${required}`).toContain(required);
    expect(bind).toMatch(/UPDATE invitation_protocol\."InvitationPresentationClaim"[\s\S]*"subjectUserId"/);
    expect(bind).toMatch(/UPDATE invitation_protocol\."InvitationOperationIdentity"[\s\S]*"subjectRole"/);
    // An existing account that signs in instead of creating credentials must converge the same setup state the
    // credential path creates, anchored to this claim's lineage; a setup row from another lineage fails closed.
    expect(bind).toMatch(/IF setup_row\."userId" IS NULL THEN[\s\S]*public\."Account"[\s\S]*"providerId"='credential'[\s\S]*"password" IS NOT NULL[\s\S]*public\."AccountSecurityState"[\s\S]*INSERT INTO invitation_protocol\."InvitationAccountSetup"\("userId","originLineageId","originLineageDigest","setupState","accountOrigin"\) VALUES\(user_row\."id",lineage_row\."id",[\s\S]*'credential_existing','pre_existing'\) ON CONFLICT \("userId"\) DO NOTHING;[\s\S]*SELECT \* INTO setup_row FROM invitation_protocol\."InvitationAccountSetup" WHERE "userId"=user_row\."id" FOR UPDATE;[\s\S]*END IF;/);
    expect(bind).toMatch(/IF setup_row\."originLineageId" IS DISTINCT FROM lineage_row\."id" THEN RAISE EXCEPTION 'invitation_bind_denied'; END IF;/);
    expect(bind.indexOf("'credential_existing'")).toBeGreaterThan(bind.indexOf("lower(btrim(user_row.\"email\"))<>lower(btrim(invite_row.\"email\"))"));
    expect(bind.indexOf("'credential_existing'")).toBeLessThan(bind.indexOf('UPDATE invitation_protocol."InvitationPresentationClaim"'));
    expect(bind).not.toContain('UPDATE public."Account"');
    expect(bind).not.toContain('UPDATE invitation_protocol."InvitationAccountSetup"');
    // Setup state must never remove an established account's ordinary access: the account origin is recorded once and is
    // immutable, pre-existing accounts stay ordinary without a subject-bound claim, and an unbound open claim changes nothing.
    expect(migration).toMatch(/CREATE TABLE invitation_protocol\."InvitationAccountSetup" \([\s\S]*"accountOrigin" TEXT NOT NULL,[\s\S]*CONSTRAINT "InvitationAccountSetup_account_origin_check" CHECK \("accountOrigin" IN \('invitation_created','pre_existing'\)\)/);
    const originGuard = procedureBody(migration, '"InvitationAccountSetup_origin_guard"');
    expect(originGuard).toContain('NEW."accountOrigin"<>OLD."accountOrigin"');
    const classifier = procedureBody(migration, "classify_invitation_setup_corridor_v2");
    expect(classifier).toContain('IF claim_row."identityId" IS NULL OR claim_row."subjectUserId" IS NULL THEN');
    expect(classifier).toMatch(/IF claim_row\."identityId" IS NULL OR claim_row\."subjectUserId" IS NULL THEN\s*IF setup_row\."userId" IS NULL OR setup_row\."setupState"='accepted' OR setup_row\."accountOrigin"='pre_existing' THEN RETURN 'ordinary'; END IF;\s*RETURN 'neutral';\s*END IF;/);
    expect(classifier).not.toMatch(/IF claim_row\."subjectUserId" IS NULL THEN RETURN 'neutral'/);
    expect(classifier).toContain('ORDER BY (claim."subjectUserId" IS NOT NULL) DESC,claim."expiresAt" DESC,claim."identityId"');
    // A pre-existing account keeps ordinary access even while an invitation claim is bound to it, so declining or
    // ignoring an invitation can never confine an established member to the setup corridor.
    const preExistingOrdinary = "IF setup_row.\"accountOrigin\"='pre_existing' THEN RETURN 'ordinary'; END IF;";
    expect(classifier.split(preExistingOrdinary)).toHaveLength(2);
    const unboundBranchStart = classifier.indexOf('IF claim_row."identityId" IS NULL OR claim_row."subjectUserId" IS NULL THEN');
    expect(unboundBranchStart).toBeGreaterThan(0);
    const unboundBranchEnd = classifier.indexOf("RETURN 'neutral';", unboundBranchStart);
    expect(unboundBranchEnd).toBeGreaterThan(0);
    expect(classifier.indexOf(preExistingOrdinary)).toBeGreaterThan(unboundBranchEnd);
    expect(classifier.indexOf(preExistingOrdinary)).toBeLessThan(classifier.indexOf('SELECT * INTO identity_row FROM invitation_protocol."InvitationOperationIdentity"'));
    expect(classifier.indexOf(preExistingOrdinary)).toBeLessThan(classifier.indexOf("RETURN 'setup_required';"));

    for (const required of [
      'InvitationPresentationClaim', 'InvitationOperationIdentity', 'InvitationLineage', 'public."Invite"', 'public."Session"', 'public."User"', 'PRESENTATION_SUBJECT_BOUND', 'reauthorize_invitation_carrier_v2', 'recompute_invitation_review_snapshot_v2',
    ]) expect(review, `review ${required}`).toContain(required);
    for (const required of [
      'no_store', 'reviewVersion', 'reviewSnapshotDigest', 'invitation-review-copy-v2', 'household_name', 'offered_role', 'capabilities', 'restrictions', 'inviter_display_name', 'masked_recipient', 'server_utc_expiry', 'localized_relative_expiry', 'reentry_state', 'access_restrictions', 'attribution_audit_privacy', 'global_security_boundary', 'other_membership_boundary', 'recovery_signin_boundary',
    ]) expect(reviewSnapshot, `review snapshot ${required}`).toContain(required);
    expect(review).not.toMatch(/(?:INSERT|UPDATE|DELETE)\s+INTO\s+invitation_protocol/i);

    for (const required of [
      'worker_attestation).invite_id<>invite_id', 'worker_attestation).issued_at', "session_user<>'cubby_invitation_expiry_worker'", 'InvitationPresentationClaim', 'InvitationOperationIdentity', 'InvitationLineage', '"tokenVersion"', '"status"=\'expired\'', 'write_invitation_tombstone_v2', "'expiry'", 'write_invitation_audit_v2', "'invite.expire'", 'invitation_expiry_denied', 'IF NOT FOUND THEN RETURN;',
    ]) expect(expiry, `expiry ${required}`).toContain(required);
    expect(expiry).toMatch(/UPDATE public\."Invite"[\s\S]*"status"='expired'/);
  });

  it("makes manual invitation and revoke procedures route-specific", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const createReserve = procedureBody(migration, "reserve_manual_invite_create_v2");
    const createSubmit = procedureBody(migration, "submit_manual_invite_create_v2");
    const createStatus = procedureBody(migration, "status_manual_invite_create_v2");
    const createAbandon = procedureBody(migration, "abandon_manual_invite_create_v2");
    const replaceReserve = procedureBody(migration, "reserve_manual_invite_replace_v2");
    const replaceSubmit = procedureBody(migration, "submit_manual_invite_replace_v2");
    const replaceStatus = procedureBody(migration, "status_manual_invite_replace_v2");
    const replaceAbandon = procedureBody(migration, "abandon_manual_invite_replace_v2");
    const revoke = procedureBody(migration, "revoke_invitation_v2");
    const revokeAll = procedureBody(migration, "revoke_all_invitations_v2");
    const authority = procedureBody(migration, "assert_invitation_issuer_authority_v2");

    expect(migration).toMatch(/revoke_invitation_v2\(invite_id TEXT, operation_id UUID, intent_fingerprint BYTEA, request_attestation invitation_protocol\.invitation_request_attestation\)/);
    expect(migration).toMatch(/revoke_all_invitations_v2\(household_id TEXT, operation_id UUID, exact_acknowledgement TEXT, intent_fingerprint BYTEA, request_attestation invitation_protocol\.invitation_request_attestation\)/);

    for (const body of [createReserve, createSubmit, createStatus, createAbandon, replaceReserve, replaceSubmit, replaceStatus, replaceAbandon, revoke, revokeAll]) {
      for (const required of [
        'InvitationOperationIdentity',
        'reauthorize_invitation_carrier_v2',
        'assert_invitation_issuer_authority_v2',
        'lock_invitation_protocol_v2',
      ]) expect(body, `manual/revoke authority ${required}`).toContain(required);
      expect(body).not.toContain('managementHandle');
      expect(body).not.toMatch(/session_user|current_setting|set_config/i);
    }
    for (const required of ['public."Session"', 'public."User"', 'public."HouseholdMember"', 'FOR UPDATE', '"disabledAt" IS NULL', '"deletedAt" IS NULL', 'invitation_issuer_forbidden']) {
      expect(authority, `current issuer authority ${required}`).toContain(required);
    }

    for (const [name, body] of [["single", revoke], ["bulk", revokeAll]] as const) {
      for (const stage of ["request", "authority", "invite_transition", "claim_close", "claim_lock", "claim_delete", "claim_tombstone", "terminal", "deferred_finalization"]) {
        expect(body, `${name} revoke diagnostic stage ${stage}`).toContain(`diagnostic_stage:='${stage}'`);
      }
      expect(body).toContain("GET STACKED DIAGNOSTICS failure_state=RETURNED_SQLSTATE");
      expect(body).toContain("SET CONSTRAINTS invitation_protocol.\"InvitationOperationIdentity_occupancy_guard\", invitation_protocol.\"InvitationPresentationClaim_occupancy_guard\", invitation_protocol.\"InvitationOperationBinding_occupancy_guard\", invitation_protocol.\"InvitationOperationResult_occupancy_guard\", invitation_protocol.\"InvitationOperationTombstone_occupancy_guard\" IMMEDIATE");
      expect(body).toContain("SET CONSTRAINTS invitation_protocol.\"InvitationOperationIdentity_occupancy_guard\", invitation_protocol.\"InvitationPresentationClaim_occupancy_guard\", invitation_protocol.\"InvitationOperationBinding_occupancy_guard\", invitation_protocol.\"InvitationOperationResult_occupancy_guard\", invitation_protocol.\"InvitationOperationTombstone_occupancy_guard\" DEFERRED");
    }

    for (const reserve of [createReserve, replaceReserve]) {
      for (const required of [
        'InvitationPreparedPayload',
        'create_invitation_identity_v2',
        'write_invitation_binding_v2',
        'opening_fingerprint',
        'invitation_reservation_invalid',
        'invitation_operation_conflict',
      ]) expect(reserve, `manual reserve ${required}`).toContain(required);
      expect(reserve).toContain('ON CONFLICT("identityId") DO NOTHING');
    }

    for (const submit of [createSubmit, replaceSubmit]) {
      for (const required of [
        'InvitationPreparedPayload',
        'write_invitation_terminal_result_v2',
        'execute_invitation_domain_transition_v2',
        'write_invitation_audit_v2',
        'gen_random_bytes(32)',
        'tokenHash',
        'inviteToken',
        'invitation_submit_invalid',
      ]) expect(submit, `manual submit ${required}`).toContain(required);
      expect(submit).toContain('DELETE FROM invitation_protocol."InvitationPreparedPayload"');
      expect(submit).toMatch(/IF .*"state"='TERMINAL_FULL'.*RETURN/s);
    }

    for (const status of [createStatus, replaceStatus]) {
      expect(status).toContain('InvitationOperationResult');
      expect(status).toContain('safeOutcome');
      expect(status).not.toMatch(/inviteToken|raw_token|normalizedRecipient|tokenHash/i);
    }

    for (const abandon of [createAbandon, replaceAbandon]) {
      for (const required of ['InvitationPreparedPayload', 'DELETE FROM invitation_protocol."InvitationOperationBinding"', 'write_invitation_tombstone_v2', 'write_invitation_audit_v2']) {
        expect(abandon, `manual abandon ${required}`).toContain(required);
      }
    }

    for (const required of [
      'InvitationOperationIdentity', 'InvitationOperationResult',
      'create_invitation_identity_v2', 'write_invitation_binding_v2', 'write_invitation_terminal_result_v2',
      'UPDATE public."Invite"', '"status"=\'revoked\'', 'InvitationPresentationClaim',
      'DELETE FROM invitation_protocol."InvitationPresentationClaim"', 'write_invitation_tombstone_v2',
      'write_invitation_audit_v2', 'invitation_operation_conflict', 'TERMINAL_FULL',
    ]) expect(revoke, `single revoke ${required}`).toContain(required);
    expect(revoke).toContain("'invite.revoke'");

    for (const required of [
      'InvitationOperationIdentity', 'InvitationOperationResult',
      'create_invitation_identity_v2', 'write_invitation_binding_v2', 'write_invitation_terminal_result_v2',
      'UPDATE public."Invite"', '"status"=\'pending\'', '"status"=\'revoked\'',
      'InvitationPresentationClaim', 'DELETE FROM invitation_protocol."InvitationPresentationClaim"',
      'write_invitation_tombstone_v2', 'write_invitation_audit_v2',
      'I_REVOKE_ALL_PENDING_INVITATIONS', 'invitation_bulk_acknowledgement_invalid',
      'invitation_operation_conflict', 'TERMINAL_FULL',
    ]) expect(revokeAll, `revoke all ${required}`).toContain(required);
    expect(revokeAll).toContain("'invite.revoke_all'");

    const carrier = procedureBody(migration, "reauthorize_invitation_carrier_v2");
    expect(carrier).toContain('InvitationRequestAttestation');
    expect(carrier).toContain('intent_fingerprint');
  });

  it("makes credential and recovery procedures route-specific", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const credentialReserve = procedureBody(migration, "reserve_invitation_credential_setup_v2");
    const credentialSubmit = procedureBody(migration, "submit_invitation_credential_setup_v2");
    const credentialStatus = procedureBody(migration, "status_invitation_credential_setup_v2");
    const credentialAbandon = procedureBody(migration, "abandon_invitation_credential_setup_v2");
    const enrollmentReserve = procedureBody(migration, "reserve_invitation_recovery_enrollment_v2");
    const enrollmentSubmit = procedureBody(migration, "submit_invitation_recovery_enrollment_v2");
    const enrollmentStatus = procedureBody(migration, "status_invitation_recovery_enrollment_v2");
    const enrollmentAbandon = procedureBody(migration, "abandon_invitation_recovery_enrollment_v2");
    const rehearsalReserve = procedureBody(migration, "reserve_invitation_recovery_rehearsal_v2");
    const rehearsalSubmit = procedureBody(migration, "submit_invitation_recovery_rehearsal_v2");
    const rehearsalStatus = procedureBody(migration, "status_invitation_recovery_rehearsal_v2");
    const rehearsalAbandon = procedureBody(migration, "abandon_invitation_recovery_rehearsal_v2");
    const preaccount = procedureBody(migration, "verify_invitation_preaccount_credential_attestation_v1");
    const credentialStatusCarrier = procedureBody(migration, "verify_invitation_credential_status_attestation_v1");
    const verifierBatch = procedureBody(migration, "verify_invitation_recovery_verifier_batch_v1");
    const rehearsalMac = procedureBody(migration, "verify_invitation_recovery_rehearsal_attestation_v1");

    for (const signature of [
      /reserve_invitation_credential_setup_v2\(operation_id UUID, claim_identity_id UUID, opening_fingerprint BYTEA, claim_attestation invitation_protocol\.invitation_preaccount_credential_attestation\)/,
      /submit_invitation_credential_setup_v2\(operation_id UUID, intent_fingerprint BYTEA, display_name TEXT, password_hash TEXT, password_hash_digest BYTEA, credential_attestation invitation_protocol\.invitation_preaccount_credential_attestation\)/,
      /status_invitation_credential_setup_v2\(operation_id UUID, status_attestation invitation_protocol\.invitation_credential_status_attestation\)/,
      /abandon_invitation_credential_setup_v2\(operation_id UUID, status_attestation invitation_protocol\.invitation_credential_status_attestation\)/,
      /reserve_invitation_recovery_enrollment_v2\(operation_id UUID, opening_fingerprint BYTEA, request_attestation invitation_protocol\.invitation_request_attestation\)/,
      /submit_invitation_recovery_enrollment_v2\(operation_id UUID, intent_fingerprint BYTEA, verifier_batch invitation_protocol\.recovery_verifier_batch, verifier_batch_digest BYTEA, issuance_attestation invitation_protocol\.invitation_request_attestation\)/,
      /status_invitation_recovery_enrollment_v2\(operation_id UUID, request_attestation invitation_protocol\.invitation_request_attestation\)/,
      /abandon_invitation_recovery_enrollment_v2\(operation_id UUID, request_attestation invitation_protocol\.invitation_request_attestation\)/,
      /reserve_invitation_recovery_rehearsal_v2\(operation_id UUID, selected_recovery_code_id TEXT, exact_save_acknowledgement TEXT, opening_fingerprint BYTEA, request_attestation invitation_protocol\.invitation_request_attestation\)/,
      /submit_invitation_recovery_rehearsal_v2\(operation_id UUID, intent_fingerprint BYTEA, selected_recovery_code_id TEXT, nonce BYTEA, attestation_key_version INTEGER, attestation_mac BYTEA, request_attestation invitation_protocol\.invitation_request_attestation\)/,
      /status_invitation_recovery_rehearsal_v2\(operation_id UUID, request_attestation invitation_protocol\.invitation_request_attestation\)/,
      /abandon_invitation_recovery_rehearsal_v2\(operation_id UUID, request_attestation invitation_protocol\.invitation_request_attestation\)/,
    ]) expect(migration).toMatch(signature);

    for (const body of [credentialReserve, credentialSubmit]) {
      for (const required of ["InvitationOperationIdentity", "lock_invitation_protocol_v2", "verify_invitation_preaccount_credential_attestation_v1"]) {
        expect(body, `credential claim/partition carrier ${required}`).toContain(required);
      }
      expect(body).not.toMatch(/secret_input|new_password|plaintext_password/i);
    }
    for (const body of [credentialStatus, credentialAbandon]) expect(body).toContain("verify_invitation_credential_status_attestation_v1");
    for (const required of ["InvitationPresentationClaim", "InvitationOperationIdentity", "InvitationLineage", 'public."Invite"', "FreshAuthAttestationKey", "browserPartitionDigest", "recipient_email_digest", "nonce", "INTERVAL '10 minutes'"]) {
      expect(preaccount, `pre-account carrier ${required}`).toContain(required);
      expect(credentialStatusCarrier, `credential status carrier ${required}`).toContain(required);
    }
    for (const required of ["browserPartitionDigest", "claim_identity_id", "create_invitation_identity_v2", "write_invitation_binding_v2", "invitation_operation_conflict"]) {
      expect(credentialReserve, `credential reserve ${required}`).toContain(required);
    }
    for (const required of ['public."Account"', 'public."AccountSecurityState"', "InvitationAccountSetup", "password_hash_digest", "continue_with_sign_in", "write_invitation_terminal_result_v2", "write_invitation_audit_v2"]) {
      expect(credentialSubmit, `credential submit ${required}`).toContain(required);
    }
    for (const required of ["existing_account", "existing_state", "\"providerId\"='credential'", "\"password\" IS NOT NULL"]) {
      expect(credentialSubmit, `existing credential check ${required}`).toContain(required);
    }
    // Credential setup is unauthenticated, so it must never create setup state for an existing account; only an
    // authenticated, email-matched post-sign-in bind may converge one.
    expect(credentialSubmit.match(/INSERT INTO invitation_protocol\."InvitationAccountSetup"/g)).toHaveLength(1);
    expect(credentialSubmit).toMatch(/INSERT INTO invitation_protocol\."InvitationAccountSetup"\("userId","originLineageId","originLineageDigest","setupState","accountOrigin"\) VALUES\(created_user_id,[\s\S]*'credential_created','invitation_created'\);/);
    expect(credentialSubmit).not.toContain("credential_existing");
    expect(credentialSubmit).not.toContain('ON CONFLICT ("userId") DO NOTHING');
    expect(credentialSubmit).not.toContain('UPDATE public."Account" SET "password"');
    expect(credentialSubmit).not.toContain('UPDATE public."User" SET "name"');
    for (const body of [credentialStatus, credentialAbandon]) expect(body).toContain("invitation_safe_receipt");
    expect(credentialAbandon).toContain("write_invitation_tombstone_v2");

    for (const body of [enrollmentReserve, enrollmentSubmit, enrollmentStatus, enrollmentAbandon, rehearsalReserve, rehearsalSubmit, rehearsalStatus, rehearsalAbandon]) {
      for (const required of ["InvitationOperationIdentity", "lock_invitation_protocol_v2", "reauthorize_invitation_carrier_v2", "InvitationRequestAttestation"]) {
        expect(body, `recovery request carrier ${required}`).toContain(required);
      }
    }
    expect(enrollmentSubmit).toContain("verify_invitation_recovery_verifier_batch_v1");
    for (const required of ["unnest", "cardinality", "count(DISTINCT", "kdf_version IS DISTINCT FROM 1", "digest(calculated", "scope_digest"]) {
      expect(verifierBatch, `closed verifier batch ${required}`).toContain(required);
    }
    for (const required of ['public."RecoveryCodeSet"', 'public."RecoveryCode"', "write_invitation_terminal_result_v2", "write_invitation_audit_v2"]) {
      expect(enrollmentSubmit, `enrollment verifier batch ${required}`).toContain(required);
    }
    const priorCodeInvalidation = enrollmentSubmit.indexOf('UPDATE public."RecoveryCode" SET "state"=\'invalidated\',"invalidatedAt"=clock_timestamp()');
    const priorSetInvalidation = enrollmentSubmit.indexOf('UPDATE public."RecoveryCodeSet" SET "state"=\'invalidated\',"updatedAt"=clock_timestamp()');
    const replacementSetInsert = enrollmentSubmit.indexOf('INSERT INTO public."RecoveryCodeSet"');
    expect(priorCodeInvalidation, "response-loss regeneration invalidates prior active codes").toBeGreaterThan(-1);
    expect(priorSetInvalidation, "response-loss regeneration invalidates the prior live set").toBeGreaterThan(priorCodeInvalidation);
    expect(replacementSetInsert, "replacement set is inserted only after prior invalidation").toBeGreaterThan(priorSetInvalidation);
    expect(enrollmentSubmit).not.toMatch(/DELETE FROM public\."RecoveryCode(Set)?"/);
    expect(enrollmentSubmit).not.toMatch(/raw.?code|plaintext/i);
    for (const body of [enrollmentStatus, rehearsalStatus]) expect(body).toContain("remainingActiveCount");
    for (const body of [enrollmentAbandon, rehearsalAbandon]) expect(body).toContain("write_invitation_tombstone_v2");

    for (const required of ["I SAVED MY RECOVERY CODES", "InvitationRecoveryRehearsalChallenge", "RecoveryCodeSet", "RecoveryCode", "gen_random_bytes(32)", "INTERVAL '10 minutes'", "saveAcknowledgementVersion"]) {
      expect(rehearsalReserve, `rehearsal reserve ${required}`).toContain(required);
    }
    expect(rehearsalReserve).not.toContain("I_SAVED_MY_RECOVERY_CODES");
    expect(rehearsalMac).toContain('FreshAuthAttestationKey');
    for (const required of ["verify_invitation_recovery_rehearsal_attestation_v1", "InvitationRecoveryRehearsalChallenge", "FOR UPDATE", '"state"=\'consumed\'', '"state"=\'rehearsed\'', "remainingActiveCount", "count(*)", "write_invitation_terminal_result_v2", "write_invitation_audit_v2", "invitation_operation_conflict"]) {
      expect(rehearsalSubmit, `rehearsal consume/replay ${required}`).toContain(required);
    }
    expect(rehearsalSubmit).toContain('"setupState"=\'rehearsed\'');
    expect(enrollmentSubmit).toContain('"setupState"=\'recovery_generated\'');
  });

  it("makes acceptance, retention, audit, and attestation paths route-specific", () => {
    const migration = readFileSync(migrationPath, "utf8");
    const acceptanceReserve = procedureBody(migration, "reserve_invitation_acceptance_v2");
    const acceptanceSubmit = procedureBody(migration, "submit_invitation_acceptance_v2");
    const acceptanceStatus = procedureBody(migration, "status_invitation_acceptance_v2");
    const acceptanceAbandon = procedureBody(migration, "abandon_invitation_acceptance_v2");
    const review = procedureBody(migration, "issue_invitation_review_v2");
    const compact = procedureBody(migration, "compact_invitation_operation_v2");
    const audit = procedureBody(migration, "write_invitation_audit_v2");
    const carrier = procedureBody(migration, "reauthorize_invitation_carrier_v2");
    const occupancy = procedureBody(migration, "\"InvitationOperationIdentity_occupancy_guard\"");
    const reviewSnapshot = procedureBody(migration, "recompute_invitation_review_snapshot_v2");

    for (const name of ["reserve_invitation_acceptance_v2", "submit_invitation_acceptance_v2"]) {
      expect([...migration.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION invitation_protocol\\.${name}\\(`, "g"))], `${name} final definition`).toHaveLength(1);
    }
    for (const body of [review, acceptanceReserve, acceptanceSubmit]) {
      expect(body, "review snapshot source").toContain("recompute_invitation_review_snapshot_v2");
    }
    expect(reviewSnapshot).toContain("cardinality(review_fields)<>14");
    expect(reviewSnapshot).toContain("lowercase_hex64");
    expect(reviewSnapshot).toContain("invitation-review-copy-v2");
    expect(acceptanceSubmit).not.toContain("review_snapshot_digest<>review_snapshot_digest");

    for (const signature of [
      /reserve_invitation_acceptance_v2\(operation_id UUID, claim_identity_id UUID, review_version INTEGER, review_snapshot_digest TEXT, opening_fingerprint BYTEA, request_attestation invitation_protocol\.invitation_request_attestation\)/,
      /submit_invitation_acceptance_v2\(operation_id UUID, review_version INTEGER, review_snapshot_digest TEXT, intent_fingerprint BYTEA, typed_household_name TEXT, nullable_admin_acknowledgement TEXT, request_attestation invitation_protocol\.invitation_request_attestation\)/,
      /status_invitation_acceptance_v2\(operation_id UUID, request_attestation invitation_protocol\.invitation_request_attestation\)/,
      /abandon_invitation_acceptance_v2\(operation_id UUID, request_attestation invitation_protocol\.invitation_request_attestation\)/,
      /compact_invitation_operation_v2\(identity_id UUID, worker_attestation invitation_protocol\.invitation_maintenance_worker_carrier\)/,
    ]) expect(migration).toMatch(signature);

    for (const body of [acceptanceReserve, acceptanceSubmit, acceptanceStatus, acceptanceAbandon]) {
      for (const required of ["InvitationPresentationClaim", "InvitationOperationIdentity", "public.\"Invite\"", "public.\"Session\"", "public.\"User\"", "InvitationRequestAttestation", "lock_invitation_protocol_v2", "reauthorize_invitation_carrier_v2"]) {
        expect(body, `acceptance carrier/recheck ${required}`).toContain(required);
      }
      expect(body).not.toContain("NULL::invitation_protocol.invitation_request_attestation");
    }

    for (const required of ["review_version", "review_snapshot_digest", "recompute_invitation_review_snapshot_v2"]) expect(acceptanceReserve, `acceptance reserve review recheck ${required}`).toContain(required);
    for (const required of ["review_version", "review_snapshot_digest", "recompute_invitation_review_snapshot_v2", "rehearsed", "remainingActiveCount"]) expect(acceptanceSubmit, `acceptance submit review recheck ${required}`).toContain(required);
    for (const required of ["review_fields", "cardinality(review_fields)<>14", "invitation-review-copy-v2", "household_name", "offered_role", "capabilities", "restrictions", "inviter_display_name", "masked_recipient", "server_utc_expiry", "localized_relative_expiry", "reentry_state", "access_restrictions", "attribution_audit_privacy", "global_security_boundary", "other_membership_boundary", "recovery_signin_boundary", "lowercase_hex64", "remainingActiveCount"]) expect(reviewSnapshot, `shared review snapshot ${required}`).toContain(required);
    for (const required of ["typed_household_name", "normalize", "I UNDERSTAND ADMIN ACCESS", "nullable_admin_acknowledgement", "already_member_same_role", "active_different_role", "suspended", "deletedAt", "HouseholdMember", "\"status\"='accepted'", "write_invitation_terminal_result_v2", "write_invitation_audit_v2", "membership.accept", "inviter_authority_lost", "stale_review"]) {
      expect(acceptanceSubmit, `acceptance submit outcome ${required}`).toContain(required);
    }
    expect(acceptanceAbandon).toContain("write_invitation_tombstone_v2");
    expect(acceptanceAbandon).toContain("membership.accept");
    expect(acceptanceStatus).toContain("InvitationOperationResult");
    expect(acceptanceSubmit).toMatch(/IF identity_row\."state"='TERMINAL_FULL'.*invitation_operation_conflict/s);

    for (const required of ["worker_attestation).identity_id<>identity_id", "session_user<>'cubby_invitation_maintenance_worker'", "TERMINAL_FULL", "INTERVAL '30 days'", "FULL_COMPACTION", "DELETE FROM invitation_protocol.\"InvitationPreparedPayload\"", "DELETE FROM invitation_protocol.\"InvitationRequestAttestation\"", "DELETE FROM invitation_protocol.\"InvitationOperationBinding\"", "DELETE FROM invitation_protocol.\"InvitationOperationResult\"", "write_invitation_tombstone_v2", "invitation.operation.compact"]) {
      expect(compact, `compaction retention ${required}`).toContain(required);
    }

    expect(migration).not.toContain("Superseded acceptance definitions");
    expect(migration).not.toContain("removed_reserve_invitation_acceptance_v2");
    expect(migration).not.toContain("removed_submit_invitation_acceptance_v2");
    expect(migration).not.toContain("GRANT EXECUTE ON FUNCTION invitation_protocol.issue_invitation_household_delete_authorization_v2");

    for (const required of ["InvitationAuditProjectionAllowlist", "invitation_audit_unknown_action", "invitation_audit_unknown_field", "jsonb_object_keys", "rawToken", "password", "recovery", "email", "INSERT INTO public.\"AuditEvent\""]) {
      expect(audit, `closed audit projection ${required}`).toContain(required);
    }

    for (const required of ["FreshAuthAttestationKey", "rotatedAt", "INTERVAL '10 minutes'", "InvitationRequestAttestation", "\"nonce\"", "FOR UPDATE", "invitation_attestation_replay_conflict", "public.hmac"]) {
      expect(carrier, `request attestation ${required}`).toContain(required);
    }
    for (const required of ["PREPARED", "SUBMITTED", "TERMINAL_FULL", "COMPACTED", "ABANDONED", "InvitationPreparedPayload", "InvitationRequestAttestation", "invitation_operation_peer_occupancy_invalid"]) {
      expect(occupancy, `deferred occupancy ${required}`).toContain(required);
    }
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER "InvitationOperationIdentity_occupancy_guard"');
    expect(migration).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA invitation_protocol FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA invitation_protocol FROM PUBLIC');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION invitation_protocol.expire_invitation_v2(TEXT,TIMESTAMPTZ,invitation_protocol.invitation_expiry_worker_carrier) TO cubby_invitation_expiry_worker');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION invitation_protocol.compact_invitation_operation_v2(UUID,invitation_protocol.invitation_maintenance_worker_carrier) TO cubby_invitation_maintenance_worker');
    expect(migration).toContain('REVOKE ALL ON FUNCTION invitation_protocol.write_invitation_audit_v2');
  });

  it("bridges invitation recovery enrollment to the existing canonical Global Security lifecycle", () => {
    const schema = readFileSync(schemaPath, "utf8");
    const migration = readFileSync(migrationPath, "utf8");
    const reserve = procedureBody(migration, "reserve_invitation_recovery_enrollment_v2");
    const submit = procedureBody(migration, "submit_invitation_recovery_enrollment_v2");
    const rehearsal = procedureBody(migration, "submit_invitation_recovery_rehearsal_v2");

    expect(schema).toContain("model InvitationRecoveryEnrollmentBridge");
    expect(migration).toContain('"InvitationRecoveryEnrollmentBridge"');
    expect(reserve).toContain('"globalSecurityOperationId"');
    expect(reserve).toContain("gso_");
    expect(migration).toContain("bind_invitation_recovery_enrollment_fresh_auth_v2");
    expect(submit).toContain('"globalSecurityOperationId"');
    expect(submit).toContain("'recovery_enrollment'::public.\"GlobalSecurityOperationKey\"");
    expect(submit).toContain("'issued'::public.\"FreshAuthGrantState\"");
    expect(submit).toContain("'pending'::public.\"GlobalSecurityOperationStatus\"");
    expect(submit).toContain("jsonb_build_object('displayOnce',true)");
    expect(submit).not.toContain("operation_id::TEXT,'recoveryEnrollment'");
    expect(submit).not.toContain("'completed',1,'recovery_codes_generated'");
    expect(rehearsal).toContain('"issuanceOperationId"');
    expect(rehearsal).toContain("'rehearsal_completed'");
    expect(rehearsal).toContain('"GlobalSecurityOperationBinding" SET "state"=\'terminal\'');
  });
});
