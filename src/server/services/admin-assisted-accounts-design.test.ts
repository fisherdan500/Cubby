import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { adminAssistedAccountsDesignSchema } from "../../../docs/design/admin-assisted-accounts-contract";

const root = process.cwd();
const protocolPath = resolve(root, "docs/design/admin-assisted-accounts-protocol.json");
const rationalePath = resolve(root, "docs/design/admin-assisted-accounts.md");

type Protocol = any;
type ProtocolColumn = { name: string; sqlType: string; nullable: boolean };

function protocol(): Protocol {
  return JSON.parse(readFileSync(protocolPath, "utf8")) as Protocol;
}

function requireProtocol(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`admin_assisted_accounts_protocol_invalid:${message}`);
}

function assertClosedProtocol(design: Protocol) {
  requireProtocol(adminAssistedAccountsDesignSchema.safeParse(design).success, "closed_schema");
  for (const section of [
    "identity", "scope", "eligibility", "mutations", "secrets", "browserOperations", "concurrency", "persistence",
    "attestation", "signInRaceClosure", "requiredChangeCorridor", "ordinaryWriteRevalidation", "compatibility", "retention", "acceptance"
  ]) requireProtocol(design[section] && typeof design[section] === "object", `missing_${section}`);

  requireProtocol(design.mutations.create.emailVerified === false, "assisted_create_must_not_verify_email");
  requireProtocol(design.mutations.create.ordinaryLoginDestination === "assisted_origin_membership_then_home", "assisted_create_home_bridge");

  const commitment = design.browserOperations.intentFingerprints?.passwordCommitment;
  requireProtocol(commitment?.algorithm === "HMAC_SHA256", "stable_intent_algorithm");
  requireProtocol(commitment?.keySource === "configuredGlobalSecurityThrottleKey", "stable_intent_key");
  requireProtocol(commitment?.domain === "cubby.admin-assisted-browser-intent.v1", "stable_intent_domain");
  requireProtocol(commitment?.passwordCanonicalization === "NFKC_UTF8_bytes", "stable_intent_password_canonicalization");
  requireProtocol(commitment?.confirmationIncluded === false, "confirmation_must_not_enter_commitment");
  requireProtocol(design.browserOperations.clientRecovery?.missingPasswordAfterNavigation === "require_reentry_or_explicit_abandon_new_draft", "navigation_secret_loss");

  requireProtocol(design.concurrency.assistedFence?.allPotentiallyConflictingRowLocks === "NOWAIT", "assisted_row_locks_nowait");
  requireProtocol(design.concurrency.assistedFence?.ordinaryWriterOrder === "Session_then_SessionSecurityActivity_and_AccountSecurityState_then_HouseholdMember", "ordinary_writer_order");
  requireProtocol(design.concurrency.sessionLocks?.includes("lock_actor_session_for_assisted_operation_nowait"), "actor_nowait_session_helper");
  requireProtocol(design.concurrency.sessionLocks?.includes("lock_user_sessions_for_assisted_operation_nowait"), "target_nowait_session_helper");

  const resetClosure = design.mutations.reset.recoverySessionClosure;
  requireProtocol(resetClosure?.appliesTo === "every_restricted_target_recovery_session", "all_restricted_recovery_sessions");
  requireProtocol(JSON.stringify(resetClosure?.orderedPerSession) === JSON.stringify([
    "advance_versions_and_attribute_both_last_operation_ids_to_assisted_bmo",
    "terminalize_own_GlobalSecurityOperation_stale_stale_security_version",
    "terminalize_own_GlobalSecurityOperationBinding",
    "close_retained_RecoverySession",
    "write_own_content_free_operation_outcome_stale_security_version_event"
  ]), "recovery_session_order");

  requireProtocol(design.requiredChangeCorridor.sessionPolicy?.ordinaryDefault === "deny_when_required_version_is_any_nonnull_value_including_invalid_or_mismatched", "nonnull_requirement_fail_closed");
  requireProtocol(design.requiredChangeCorridor.transitionMatrix?.assisted_reset_checked === "set_to_new_credential_version", "checked_reset_requirement");
  requireProtocol(design.requiredChangeCorridor.transitionMatrix?.assisted_reset_unchecked === "clear_after_success_closure", "unchecked_reset_requirement");
  requireProtocol(design.requiredChangeCorridor.transitionMatrix?.canonical_self_password_change === "rebind_then_deferred_clear_after_existing_hash_mutation_receipt", "self_change_clear");
  requireProtocol(design.requiredChangeCorridor.transitionMatrix?.offline_recovery_reset === "preserve_and_rebind_to_new_credential_version", "recovery_requirement_rebind");
  requireProtocol(Array.isArray(design.requiredChangeCorridor.clearClosure) && design.requiredChangeCorridor.clearClosure.includes("PasswordChangeCredentialMutation_existing_row_created_by_apply_password_change_credential_mutation"), "real_self_change_receipt");
  requireProtocol(!design.requiredChangeCorridor.clearClosure.includes("passwordHashDigest"), "no_phantom_self_change_hash_field");

  const models = design.persistence.models;
  requireProtocol(JSON.stringify(models.AssistedCredentialMutation?.columns?.map((column: ProtocolColumn) => [column.name, column.sqlType, column.nullable])) === JSON.stringify([
    ["householdId", "TEXT", false], ["operationId", "TEXT", false], ["operationKey", "BrowserOperationKey", false],
    ["browserBindingId", "TEXT", false], ["actorUserId", "TEXT", false], ["actorSessionId", "TEXT", false],
    ["actorMemberId", "TEXT", false], ["targetUserId", "TEXT", false], ["targetMemberId", "TEXT", false],
    ["accountId", "TEXT", false], ["openingFingerprint", "TEXT", false], ["intentFingerprint", "TEXT", false],
    ["oldCredentialVersion", "INTEGER", true], ["newCredentialVersion", "INTEGER", false],
    ["oldSessionSecurityVersion", "INTEGER", true], ["newSessionSecurityVersion", "INTEGER", false],
    ["passwordHashDigest", "BYTEA", false], ["requireFirstLoginPasswordChange", "BOOLEAN", false],
    ["attestationNonce", "BYTEA", false], ["attestationKeyVersion", "INTEGER", false],
    ["attestationIssuedAt", "TIMESTAMP(3)", false], ["attestationMacDigest", "BYTEA", false], ["createdAt", "TIMESTAMP(3)", false]
  ]), "receipt_column_parity");
  requireProtocol(JSON.stringify(models.AssistedAccountState?.columns?.map((column: ProtocolColumn) => [column.name, column.sqlType, column.nullable])) === JSON.stringify([
    ["userId", "TEXT", false], ["assistedCreationHouseholdId", "TEXT", true], ["assistedCreationMemberId", "TEXT", true],
    ["assistedCreationOperationId", "TEXT", true], ["requiredChangeCredentialVersion", "INTEGER", true],
    ["createdAt", "TIMESTAMP(3)", false], ["updatedAt", "TIMESTAMP(3)", false]
  ]), "state_column_parity");
  requireProtocol(JSON.stringify(models.SessionPrivateCredentialProof?.columns?.map((column: ProtocolColumn) => [column.name, column.sqlType, column.nullable])) === JSON.stringify([
    ["credentialProofPurpose", "TEXT", true], ["credentialProofHashDigest", "BYTEA", true],
    ["credentialProofIssuedAt", "TIMESTAMP(3)", true], ["credentialProofNonce", "BYTEA", true],
    ["credentialProofKeyVersion", "INTEGER", true], ["credentialProofMac", "BYTEA", true]
  ]), "session_proof_column_parity");
  requireProtocol(models.AssistedCredentialMutation?.lifecycle?.soleDeletePath === "target_User_hard_delete_FK_cascade", "receipt_lifecycle");
  requireProtocol(models.AssistedAccountState?.lifecycle?.soleDeletePath === "target_User_hard_delete_FK_cascade", "state_lifecycle");
  requireProtocol(models.AssistedCredentialMutation?.foreignKeys?.length === 1 && models.AssistedCredentialMutation.foreignKeys[0].column === "targetUserId", "receipt_snapshot_fk_boundary");
  requireProtocol(models.AssistedAccountState?.foreignKeys?.length === 1 && models.AssistedAccountState.foreignKeys[0].column === "userId", "state_snapshot_fk_boundary");
  requireProtocol(models.SessionPrivateCredentialProof?.columns?.every((column: ProtocolColumn) => typeof column.name === "string" && typeof column.sqlType === "string" && typeof column.nullable === "boolean"), "session_field_types");
  requireProtocol(design.secrets.allowedPersistence?.includes("sha256_password_hash_digest_in_receipt"), "random_hash_evidence_retained");
  requireProtocol(!design.browserOperations.intentFingerprints.memberAccountCreate.includes("passwordHashDigest") && !design.browserOperations.intentFingerprints.memberPasswordReset.includes("passwordHashDigest"), "stable_commitment_not_random_hash_digest");

  const closure = design.persistence.deferredSuccessClosure;
  requireProtocol(closure?.receiptTrigger?.timing === "AFTER_INSERT_CONSTRAINT_DEFERRABLE_INITIALLY_DEFERRED", "receipt_deferred_trigger");
  requireProtocol(closure?.operationConverseTrigger?.timing === "AFTER_INSERT_OR_UPDATE_CONSTRAINT_DEFERRABLE_INITIALLY_DEFERRED", "operation_converse_trigger");
  requireProtocol(closure?.checks?.includes("selected_required_flag_and_origin_exactly_match_receipt_and_assisted_state"), "checkbox_state_closure");
  requireProtocol(closure?.checks?.includes("exactly_one_content_free_audit"), "audit_closure");

  requireProtocol(design.attestation.frame?.fields?.includes("issuedAt_timestamp3_microseconds_since_2000_i64be"), "assisted_attestation_signed_issued_at");
  requireProtocol(design.attestation.freshness?.maximumDatabaseAgeSeconds === 600 && design.attestation.freshness?.maximumFutureSkewSeconds === 5, "assisted_attestation_freshness");
  requireProtocol(design.attestation.databaseValidation?.includes("issuedAt_signed_and_within_database_freshness_window"), "assisted_attestation_database_time");
  requireProtocol(design.signInRaceClosure.sessionProofFrame?.fields?.includes("issuedAt_timestamp3_microseconds_since_2000_i64be"), "signin_proof_signed_issued_at");
  requireProtocol(design.signInRaceClosure.alsWiring?.routeWrapper === "wrap_complete_Better_Auth_route_handler_in_AsyncLocalStorage_run", "als_route_wrapper");

  requireProtocol(design.browserOperations.replay?.commitClosureOnly?.includes("current_version_vector"), "commit_only_versions");
  requireProtocol(!design.browserOperations.replay?.historicalSuccessProof?.includes("current_version_vector"), "historical_replay_no_current_versions");
  requireProtocol(!design.browserOperations.replay?.historicalSuccessProof?.includes("credential_hash_digest_matches_current"), "historical_replay_no_current_hash");
  requireProtocol(design.browserOperations.statusProjection?.fields?.every((field: string) => !/hash|mac|session/i.test(field)), "finite_status_projection");

  requireProtocol(JSON.stringify(design.requiredChangeCorridor.internalIdentityClassification) === JSON.stringify(["ordinary", "restricted", "unauthenticated"]), "identity_classification");
  requireProtocol(design.requiredChangeCorridor.passwordChange?.replacementMustDifferBy === "better_auth_verifyPassword_against_current_hash_NFKC_semantics", "different_password_verification");
  requireProtocol(design.requiredChangeCorridor.passwordChange?.sameNormalizedPasswordOutcome === "reject_and_keep_requirement", "same_password_keeps_requirement");

  requireProtocol(design.ordinaryWriteRevalidation.contextTypes?.browser?.sessionId === "required_server_derived", "browser_session_carrier");
  requireProtocol(design.ordinaryWriteRevalidation.contextTypes?.api_key?.sessionId === "forbidden", "api_key_no_fake_session");
  requireProtocol(design.ordinaryWriteRevalidation.browserTransactionCheck?.includes("no_nonnull_requiredChangeCredentialVersion"), "write_requirement_recheck");
  requireProtocol(design.ordinaryWriteRevalidation.lockActorForWriteCallers?.includes("src/server/services/integrations.ts:savePushSubscription"), "push_writer_inventory");

  const cases = design.acceptance.databaseCases;
  requireProtocol(cases.concurrency?.includes("ordinary_writer_paused_after_session_lock_assisted_nowait_rolls_back_then_both_complete_without_deadlock"), "deterministic_lock_inversion_test");
  requireProtocol(cases.reset?.includes("pending_recovery_every_associated_guard_failure_rolls_back"), "recovery_guard_rollback_test");
  requireProtocol(cases.requiredChange?.includes("checked_reset_then_offline_recovery_signin_still_restricted"), "recovery_rebind_test");
  requireProtocol(cases.writes?.includes("push_subscription_write_first_succeeds_reset_first_rejects_without_upsert_resurrection"), "push_interleaving_test");
}

describe("admin-assisted accounts phase-one design contract", () => {
  it("rejects missing, extra, and contradictory rules throughout the finite contract", () => {
    const source = protocol();
    const paths: Array<Array<string | number>> = [];
    const objects: Array<Array<string | number>> = [];
    function visit(value: unknown, path: Array<string | number>) {
      if (value !== null && typeof value === "object") {
        if (!Array.isArray(value)) objects.push(path);
        for (const [key, child] of Object.entries(value)) {
          const childPath = [...path, Array.isArray(value) ? Number(key) : key];
          paths.push(childPath);
          visit(child, childPath);
        }
      }
    }
    visit(source, []);
    const at = (value: Protocol, path: Array<string | number>) => path.reduce((node, key) => node[key], value);
    for (const path of paths) {
      const missing = structuredClone(source);
      delete at(missing, path.slice(0, -1))[path[path.length - 1]];
      expect(() => assertClosedProtocol(missing), `missing:${path.join(".")}`).toThrow(/admin_assisted_accounts_protocol_invalid:closed_schema/);
      const original = at(source, path);
      if (original === null || typeof original !== "object") {
        const changed = structuredClone(source);
        at(changed, path.slice(0, -1))[path[path.length - 1]] = typeof original === "boolean" ? !original : "contradictory_rule";
        expect(() => assertClosedProtocol(changed), `changed:${path.join(".")}`).toThrow(/admin_assisted_accounts_protocol_invalid:closed_schema/);
      }
    }
    for (const path of objects) {
      const extra = structuredClone(source);
      at(extra, path).__unexpected_contract_rule__ = true;
      expect(() => assertClosedProtocol(extra), `extra:${path.join(".")}`).toThrow(/admin_assisted_accounts_protocol_invalid:closed_schema/);
    }
  }, 30_000);

  it.each<Array<[string, (design: Protocol) => void]>[number]>([
    ["page navigation", (design) => { delete design.requiredChangeCorridor.pageNavigation; }],
    ["commitment identity and secret bindings", (design) => {
      design.browserOperations.intentFingerprints.passwordCommitment.commonFields = [];
      design.browserOperations.intentFingerprints.passwordCommitment.memberPasswordResetFields = [];
    }],
    ["atomic sign-in effects", (design) => { delete design.signInRaceClosure.atomicIntegration; }],
    ["immutable session proof", (design) => { design.persistence.models.SessionPrivateCredentialProof.lifecycle.update = "unrestricted"; }],
    ["mutation-time session authorization", (design) => {
      delete design.ordinaryWriteRevalidation.browserTransactionHelper;
      design.ordinaryWriteRevalidation.browserTransactionCheck = ["no_nonnull_requiredChangeCredentialVersion"];
    }],
    ["database attestation verification", (design) => {
      design.attestation.databaseValidation = ["issuedAt_signed_and_within_database_freshness_window"];
    }],
    ["request-isolated proof ownership", (design) => {
      delete design.signInRaceClosure.alsWiring.oneStorePerRequest;
      delete design.signInRaceClosure.alsWiring.failedVerifyStore;
      delete design.signInRaceClosure.alsWiring.sessionCreateBefore;
    }],
    ["same-effective-password acceptance case", (design) => {
      design.acceptance.databaseCases.requiredChange = design.acceptance.databaseCases.requiredChange.filter((value: string) => !value.includes("NFKC"));
    }]
  ])("rejects removal or contradiction of %s", (_name, mutate) => {
    const design = structuredClone(protocol());
    mutate(design);
    expect(() => assertClosedProtocol(design)).toThrow(/admin_assisted_accounts_protocol_invalid/);
  });

  it("passes the complete closed protocol validator", () => {
    assertClosedProtocol(protocol());
  });

  it("rejects deleted or contradictory critical security sections in memory", () => {
    const mutations: Array<[string, (design: Protocol) => void]> = [
      ["intent fingerprints deleted", (design: Protocol) => { delete design.browserOperations.intentFingerprints; }],
      ["client recovery deleted", (design: Protocol) => { delete design.browserOperations.clientRecovery; }],
      ["deferred closure deleted", (design: Protocol) => { delete design.persistence.deferredSuccessClosure; }],
      ["attestation validation deleted", (design: Protocol) => { delete design.attestation.databaseValidation; }],
      ["session proof frame deleted", (design: Protocol) => { delete design.signInRaceClosure.sessionProofFrame; }],
      ["required-change clear closure deleted", (design: Protocol) => { delete design.requiredChangeCorridor.clearClosure; }],
      ["email verification contradicted", (design: Protocol) => { design.mutations.create.emailVerified = true; }],
      ["blocking assisted row locks", (design: Protocol) => { design.concurrency.assistedFence.allPotentiallyConflictingRowLocks = "BLOCKING"; }],
      ["mutable version added to replay", (design: Protocol) => { design.browserOperations.replay.historicalSuccessProof.push("current_version_vector"); }],
      ["offline recovery clears requirement", (design: Protocol) => { design.requiredChangeCorridor.transitionMatrix.offline_recovery_reset = "clear"; }],
      ["same normalized password accepted", (design: Protocol) => { design.requiredChangeCorridor.passwordChange.sameNormalizedPasswordOutcome = "accept"; }],
      ["browser session carrier optional", (design: Protocol) => { design.ordinaryWriteRevalidation.contextTypes.browser.sessionId = "optional"; }],
      ["receipt column removed", (design: Protocol) => { design.persistence.models.AssistedCredentialMutation.columns.pop(); }],
      ["state lifecycle broadened", (design: Protocol) => { design.persistence.models.AssistedAccountState.lifecycle.soleDeletePath = "ordinary_delete"; }],
      ["random hash used as stable intent", (design: Protocol) => { design.browserOperations.intentFingerprints.memberPasswordReset.push("passwordHashDigest"); }],
      ["commit closure loses checkbox equality", (design: Protocol) => { design.persistence.deferredSuccessClosure.checks = design.persistence.deferredSuccessClosure.checks.filter((value: string) => value !== "selected_required_flag_and_origin_exactly_match_receipt_and_assisted_state"); }]
    ];
    for (const [name, mutate] of mutations) {
      const design = structuredClone(protocol());
      mutate(design);
      expect(() => assertClosedProtocol(design), name).toThrow(/admin_assisted_accounts_protocol_invalid/);
    }
  });

  it("is pinned to the approved branch, base, scope, and operation literals", () => {
    const design = protocol();
    expect(design.identity).toEqual({
      protocol: "cubby.admin-assisted-accounts.phase1",
      version: 1,
      branch: "feat/admin-assisted-accounts",
      base: "76580f970b62890cd0792cc96e713dbc8a5f913d",
      status: "design_only"
    });
    expect(design.scope.delivered).toEqual(["assisted_create", "assisted_reset", "required_first_password_change"]);
    expect(design.scope.deferred).toEqual(["self_service_signup", "emailed_password_recovery", "phase2"]);
    expect(design.browserOperations.keys).toEqual([
      { prisma: "memberAccountCreate", database: "member.account.create", targetKind: "household" },
      { prisma: "memberPasswordReset", database: "member.password.reset", targetKind: "member" }
    ]);
    expect(design.browserOperations.enumMigration).toEqual({ separateAdditiveFile: true, valuesOnly: true });
  });

  it("defines exact actor, target, and cross-household eligibility", () => {
    const eligibility = protocol().eligibility;
    expect(eligibility.roleMatrix).toEqual({
      owner: ["admin", "parent", "caretaker", "read_only"],
      admin: ["parent", "caretaker", "read_only"],
      parent: [],
      caretaker: [],
      read_only: []
    });
    expect(eligibility.denials).toEqual([
      "target_household_owner",
      "target_platform_owner",
      "target_is_actor_user_id",
      "actor_session_not_fresh_10_db_minutes",
      "actor_membership_not_current",
      "actor_role_not_permitted",
      "target_role_not_permitted",
      "reset_target_not_current_household_member",
      "reset_target_has_any_other_nondeleted_membership"
    ]);
    expect(eligibility.otherMembershipPredicate).toEqual({
      membershipDeletedAt: null,
      householdId: "not_current_household",
      ignoreMembershipDisabledAt: true,
      ignoreHouseholdDeletedAt: true,
      disclosure: "personal_recovery_unavailable"
    });
    expect(eligibility.existingEmailCreate).toEqual({
      mutation: "none",
      outcomeCode: "existing_account_invitation_required",
      nextAction: "existing_invitation_flow"
    });
  });

  it("fixes validation, defaults, credential effects, and content boundaries", () => {
    const mutations = protocol().mutations;
    expect(mutations.create.input).toEqual({
      name: "trimmed_nonempty_1_191",
      email: "single_mailbox_normalized_lowercase",
      password: "better_auth_8_128",
      passwordConfirmation: "exact_password_match",
      role: ["admin", "parent", "caretaker", "read_only"],
      requireFirstLoginPasswordChange: { type: "boolean", default: false }
    });
    expect(mutations.reset.input).toEqual({
      targetMemberId: "current_household_nonremoved_member",
      password: "better_auth_8_128",
      passwordConfirmation: "exact_password_match",
      requireFirstLoginPasswordChange: { type: "boolean", default: false, uncheckedEffect: "clear_requirement_for_replacement_credential" }
    });
    expect(mutations.create.versionTransition).toEqual({ credentialVersion: [null, 1], sessionSecurityVersion: [null, 1] });
    expect(mutations.create.emailVerified).toBe(false);
    expect(mutations.create.writesInOneTransaction).toContain("User_emailVerified_false");
    expect(mutations.create.writesInOneTransaction).not.toContain("User_emailVerified_true");
    expect(mutations.reset.versionTransition).toEqual({ credentialVersion: "old_plus_1", sessionSecurityVersion: "old_plus_1" });
    expect(mutations.reset.revocations).toEqual([
      "all_target_sessions",
      "all_active_session_security_activity",
      "all_issued_fresh_auth_grants",
      "all_restricted_recovery_sessions"
    ]);
    expect(protocol().secrets).toEqual({
      plaintextLifetime: "request_memory_until_hash_then_drop",
      hashTiming: "before_lock_transaction",
      forbiddenPersistence: ["plaintext", "confirmation", "unkeyed_plaintext_digest", "browser_operation_payload", "logs", "audit", "receipt"],
      allowedPersistence: ["password_hash_in_Account", "sha256_password_hash_digest_in_receipt"]
    });
  });

  it("defines a finite durable operation machine with safe replay and unknown-outcome recovery", () => {
    const operations = protocol().browserOperations;
    expect(operations.states).toEqual(["absent", "open", "submitted_pending", "submitted_unknown", "terminal_full", "compacted", "abandoned", "expired"]);
    expect(operations.transitions).toEqual([
      ["absent", "open", "reserve"],
      ["open", "submitted_pending", "submit_identity"],
      ["submitted_pending", "terminal_full", "atomic_commit"],
      ["submitted_pending", "submitted_unknown", "ambiguous_transport"],
      ["submitted_unknown", "terminal_full", "status_receipt_proof"],
      ["open", "abandoned", "abandon"],
      ["open", "expired", "lease_expiry"],
      ["terminal_full", "compacted", "retention_30_days"]
    ]);
    expect(operations.terminalSchemas).toEqual({
      memberAccountCreate: {
        completed: { kind: "member_account", code: "created", fields: ["memberId"] },
        rejected: ["existing_account_invitation_required"],
        stale: ["stale_context", "stale_target", "stale_revision"]
      },
      memberPasswordReset: {
        completed: { kind: "member_password", code: "reset", fields: ["memberId"] },
        rejected: ["personal_recovery_unavailable"],
        stale: ["stale_context", "stale_target", "stale_revision"]
      },
      common: {
        conflict: "idempotency_conflict",
        pending: "operation_unknown",
        compacted: "operation_result_expired",
        abandoned: "operation_abandoned"
      }
    });
    expect(operations.replay).toEqual({
      reauthorize: ["actor_session", "actor_membership", "actor_current_role", "target_scope", "protected_target_denials", "cross_household_reset_denial"],
      neverRequire: ["opening_credential_version_after_success", "old_password_hash_after_success", "current_target_credential_version", "current_target_credential_hash", "zero_current_target_sessions"],
      historicalSuccessProof: ["completed_binding", "terminal_operation", "matching_AssistedCredentialMutation_or_compaction_tombstone_relationship", "immutable_actor_target_origin_and_selected_flag_evidence"],
      commitClosureOnly: ["current_version_vector", "credential_hash_digest", "session_invalidation", "grant_and_recovery_closure"],
      subsequentTransitions: "must_not_invalidate_old_outcome_repeat_mutation_or_clear_newer_required_change",
      mutationCount: 0,
      auditCount: 0
    });
  });

  it("pins the earliest hook, global lock order, bounded retries, and row predicates", () => {
    const concurrency = protocol().concurrency;
    expect(concurrency.earliestHook).toEqual({
      name: "preIdentityLock",
      appliesTo: ["reserve", "submit", "status", "abandon"],
      before: ["household_browser_operation_identity", "BrowserOperationBinding"],
      existingPreActorLockRetainedForOtherOperations: true
    });
    expect(concurrency.lockOrder).toEqual([
      "global-security-transition:v1",
      "HouseholdMember_TABLE_EXCLUSIVE_NOWAIT",
      "PlatformAuthority_SHARE_NOWAIT",
      "PlatformSettings_SHARE_NOWAIT",
      "User_ids_ascending_NOWAIT",
      "AccountSecurityState_user_ids_ascending_NOWAIT",
      "Account_credential_ids_ascending_NOWAIT",
      "Session_via_restricted_assisted_NOWAIT_functions_ids_ascending",
      "SessionSecurityActivity_session_ids_ascending_NOWAIT",
      "FreshAuthGrant_ids_ascending_NOWAIT",
      "RecoverySession_ids_ascending_NOWAIT",
      "GlobalSecurityOperationBinding_ids_ascending_NOWAIT",
      "GlobalSecurityOperation_user_operation_ids_ascending_NOWAIT",
      "HouseholdMember_ids_ascending_NOWAIT",
      "Household_ids_ascending_NOWAIT",
      "browser_operation_identity_and_binding_NOWAIT",
      "AssistedCredentialMutation_insert"
    ]);
    expect(concurrency.retry).toEqual({
      wholeTransactionOnly: true,
      attempts: 3,
      sqlstates: ["55P03", "40001", "40P01"],
      backoffMilliseconds: [0, 25, 75],
      partialStatementRetry: false
    });
    expect(concurrency.sessionLocks).toEqual([
      "lock_actor_session_for_assisted_operation_nowait",
      "lock_user_sessions_for_assisted_operation_nowait"
    ]);
  });

  it("defines immutable receipts, guarded state, procedures, and exact grants", () => {
    const persistence = protocol().persistence;
    expect(persistence.models.AssistedCredentialMutation.columns.map((column: ProtocolColumn) => column.name)).toEqual([
      "householdId", "operationId", "operationKey", "browserBindingId", "actorUserId", "actorSessionId", "actorMemberId",
      "targetUserId", "targetMemberId", "accountId", "openingFingerprint", "intentFingerprint", "oldCredentialVersion",
      "newCredentialVersion", "oldSessionSecurityVersion", "newSessionSecurityVersion", "passwordHashDigest",
      "requireFirstLoginPasswordChange", "attestationNonce", "attestationKeyVersion", "attestationIssuedAt", "attestationMacDigest", "createdAt"
    ]);
    expect(persistence.models.AssistedCredentialMutation.guards).toEqual(["insert_only_by_definer", "immutable", "nonce_unique", "deferred_success_closure", "ordinary_update_delete_truncate_blocked"]);
    expect(persistence.models.AssistedAccountState.columns.map((column: ProtocolColumn) => column.name)).toEqual(["userId", "assistedCreationHouseholdId", "assistedCreationMemberId", "assistedCreationOperationId", "requiredChangeCredentialVersion", "createdAt", "updatedAt"]);
    expect(persistence.models.AssistedAccountState).toMatchObject({
      primaryKey: ["userId"], creationOriginShape: "all_three_origin_fields_null_or_all_three_nonnull", dml: "definer_only",
      originMutation: "immutable_no_reassignment_or_adoption", clearRule: "closed_transition_matrix_only"
    });
    expect(persistence.procedures).toEqual([
      "acquire_assisted_credential_fence_v1()",
      "lock_actor_session_for_assisted_operation_nowait(text,text)",
      "lock_user_sessions_for_assisted_operation_nowait(text)",
      "lock_actor_session_for_browser_write_v1(text,text)",
      "create_assisted_member_account_v1(text,text,text,text,text,text,text,text,text,HouseholdRole,text,bytea,boolean,integer,bytea,timestamp,bytea)",
      "reset_assisted_member_password_v1(text,text,text,text,text,text,text,text,integer,integer,text,bytea,boolean,integer,bytea,timestamp,bytea)",
      "get_assisted_account_operation_status_v1(text,text,text,text)",
      "sign_out_required_change_session_v1(text,text)"
    ]);
    expect(persistence.grants.cubby_runtime).toEqual({
      tables: { AssistedAccountState: ["SELECT"], AssistedCredentialMutation: [] },
      execute: persistence.procedures,
      denied: ["User_DML", "Account_DML", "Session_DML", "AssistedAccountState_DML", "AssistedCredentialMutation_DML", "FreshAuthAttestationKey_SELECT"]
    });
    expect(persistence.grants.cubby_auth).toEqual({
      sessionProofColumns: ["INSERT", "SELECT", "UPDATE", "DELETE"],
      directCredentialMutation: false,
      freshAuthKeyRead: false
    });
  });

  it("pins purpose-separated credential attestations and the old-password sign-in race closure", () => {
    const attestation = protocol().attestation;
    expect(attestation.keySource).toBe("CUBBY_FRESH_AUTH_ATTESTATION_KEYRING");
    expect(attestation.newSecretConfiguration).toBe(false);
    expect(attestation.frame).toEqual({
      encoding: "domain_then_u32be_length_prefixed_fields_and_fixed_width_integers",
      domain: "cubby.admin-assisted-credential-mutation.v1",
      fields: ["purpose", "actorUserId", "actorSessionId", "actorMemberId", "householdId", "operationId", "openingFingerprint", "intentFingerprint", "replacementPasswordHashDigest", "newValuesDigest", "oldCredentialVersion", "oldSessionSecurityVersion", "issuedAt_timestamp3_microseconds_since_2000_i64be", "nonce", "keyVersion"]
    });
    expect(attestation.rotation).toEqual({ active: "accepted", prior: "accepted_only_when_rotatedAt_plus_10_db_minutes_is_future", others: "rejected", replay: "nonce_unique" });

    const signIn = protocol().signInRaceClosure;
    expect(signIn.betterAuthVersion).toBe("1.6.19");
    expect(signIn.requestIsolation).toBe("AsyncLocalStorage_per_auth_request");
    expect(signIn.sessionAdditionalFields).toEqual({
      credentialProofPurpose: { input: false, returned: false },
      credentialProofHashDigest: { input: false, returned: false },
      credentialProofIssuedAt: { input: false, returned: false },
      credentialProofNonce: { input: false, returned: false },
      credentialProofKeyVersion: { input: false, returned: false },
      credentialProofMac: { input: false, returned: false }
    });
    expect(signIn.trigger).toEqual({
      name: "Session_00_credential_proof_guard",
      timing: "BEFORE INSERT",
      security: "SECURITY DEFINER fixed_search_path PUBLIC_revoked",
      firstLock: "global-security-transition:v1",
      requireWhen: "session_user_equals_cubby_auth",
      exemptWhen: "trusted_email_rotation_definer_identity_only",
      validates: ["purpose", "userId", "sha256_session_token", "sha256_current_stored_credential_hash", "issuedAt_not_more_than_5_seconds_future_and_within_10_db_minutes", "nonce", "keyVersion", "mac", "nonce_not_replayed"]
    });
    expect(signIn.orderings).toEqual({
      signInFirst: "session_insert_then_reset_deletes_session",
      resetFirst: "stored_hash_digest_mismatch_rejects_session_insert"
    });
    expect(signIn.atomicEffects).toEqual(["Session", "SessionSecurityActivity", "GlobalSecurityEvent_sign_in_succeeded"]);
  });

  it("defines the required-change corridor, assisted home bridge, and unchanged boundaries", () => {
    const corridor = protocol().requiredChangeCorridor;
    expect(corridor.sessionPolicy).toMatchObject({
      ordinaryDefault: "deny_when_required_version_is_any_nonnull_value_including_invalid_or_mismatched",
      publicGetSession: "restricted_returns_null",
      purposeSource: "server_constant_only",
      clientControlledPurpose: false,
      themeBehavior: "DEFAULT_APPEARANCE_MODE_fallback"
    });
    expect(corridor.allowlist).toEqual([
      ["GET", "/account/required-password-change", "identity_only"],
      ["POST", "/api/account/security/required-password-change", "identity_and_password_change"],
      ["POST", "/api/account/security/required-password-change/status", "identity_and_status"],
      ["POST", "/api/account/sign-out", "identity_and_current_session_delete"],
      ["GET", "/invite/dispatch", "identity_and_route_only"],
      ["POST", "/api/account/assisted-post-sign-in", "identity_and_origin_membership_selection"]
    ]);
    expect(corridor.deniedSurfaces).toEqual(["requireUser", "getHouseholdContext", "invitation_corridor", "account_appearance", "platform", "history", "browser_operation_status", "all_app_routes"]);
    expect(corridor.clear).toEqual({ trigger: "AssistedAccountState_required_change_transition_guard_and_deferred_clear", source: "closed_transition_matrix", deferred: true, uiSetter: false, standaloneSetter: false });
    expect(corridor.assistedHomeBridge).toEqual({
      selectedMembership: "AssistedAccountState.assistedCreationMemberId_only",
      requireStillAuthorized: true,
      arbitraryFirstMembershipFallback: false,
      success: "/app",
      unavailable: "/"
    });
    expect(protocol().compatibility).toMatchObject({
      invitationFlow: "unchanged",
      invitationAccountSetupForAssistedCreate: "none",
      offlineData: "unchanged",
      ordinaryLoginDestination: "assisted_bridge_then_home",
      recoveryLink: "none",
      crossHouseholdMessage: "For privacy, this password cannot be reset here. Personal emailed recovery is not available yet.",
      phase2: ["self_service_signup", "emailed_password_recovery"]
    });
  });

  it("defines lifecycle retention and the complete implementation acceptance gate", () => {
    const design = protocol();
    expect(design.retention).toMatchObject({
      browserTerminalFullDays: 30,
      browserTombstone: "lifetime_operation_identity_content_free",
      AssistedCredentialMutation: "until_target_user_hard_delete",
      AssistedAccountState: "until_target_user_hard_delete",
      sessionCredentialProof: "until_session_delete",
      householdBackup: "all_assisted_state_receipts_proofs_full_operations_and_tombstones_excluded",
      fullSystemBackup: "all_assisted_state_receipts_proofs_full_operations_and_tombstones_included"
    });
    expect(design.acceptance.required).toEqual(expect.arrayContaining([
      "focused_unit_TDD",
      "restricted_role_grants_and_denials",
      "transaction_rollback",
      "actor_role_race",
      "target_role_race",
      "target_email_race",
      "cross_household_active_membership",
      "cross_household_disabled_membership",
      "cross_household_deleted_household_membership",
      "reset_then_signin_race",
      "signin_then_reset_race",
      "concurrent_signin_ALS_isolation",
      "replay_and_unknown_outcome",
      "legacy_session_compatibility",
      "rendered_browser_default_home",
      "rendered_browser_required_change_corridor",
      "rendered_browser_self_change_signin_home",
      "rendered_browser_reset_old_sessions",
      "responsive_mobile_UI",
      "npm_run_typecheck",
      "npm_run_lint",
      "npm_run_test",
      "npm_run_verify_browser_operation_save_path",
      "npm_run_build",
      "frozen_independent_review",
      "exact_head_CI"
    ]));
    expect(design.acceptance.browserArtifactPolicy).toEqual({ screenshots: false, headers: false, cookies: false, logs: false, passwords: false, fixturesOnly: true, realSmtp: false });
  });

  it("documents concrete source integration and an acceptance checklist", () => {
    const rationale = readFileSync(rationalePath, "utf8");
    for (const heading of ["# Admin-assisted accounts phase one", "## Decisions", "## Source integration", "## Acceptance checklist", "## Hard source constraint"]) {
      expect(rationale).toContain(heading);
    }
    for (const source of [
      "src/server/services/browser-operations.ts",
      "src/lib/auth/auth.ts",
      "src/server/auth/session.ts",
      "src/server/auth/context.ts",
      "src/server/services/invitation-setup-corridor.ts",
      "src/server/services/global-security.ts",
      "src/server/services/fresh-auth-attestation.ts",
      "prisma/migrations/20260916120000_actor_session_lock_function/migration.sql",
      "node_modules/better-auth/dist/api/routes/sign-in.mjs",
      "node_modules/better-auth/dist/db/with-hooks.mjs"
    ]) expect(rationale).toContain(source);
    expect(rationale).toContain("`preActorLock` cannot satisfy the required order");
    expect(rationale).not.toMatch(/TBD|TODO|to be decided|placeholder/i);
  });
});
