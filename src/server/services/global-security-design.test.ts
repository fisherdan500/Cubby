import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schemaPath = fileURLToPath(new URL("../../../prisma/schema.prisma", import.meta.url));
const migrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260824140000_global_security_foundation/migration.sql", import.meta.url));
const phase8MigrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260829120000_global_security_throttle_core/migration.sql", import.meta.url));
const globalSecurityEnums = ["GlobalSecurityOperationKey", "GlobalSecurityOperationStatus", "FreshAuthGrantState", "RecoveryCodeState", "RecoveryCodeSetState", "RecoveryCodeConsumptionPurpose", "RecoverySessionState", "EmailChangeState", "EmailChangeDeliveryKind", "EmailChangeDeliveryState", "EmailChangeCookieState", "GlobalSecurityIncidentState", "SessionSecurityActivityState", "BrowserOperationBindingState"];
const normalizeSql = (value: string) => value.replace(/\s+/g, " ").trim();
const modelBlock = (schema: string, model: string) => schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
const migrationTable = (migration: string, model: string) => migration.match(new RegExp(`CREATE TABLE "${model}" \\([\\s\\S]*?\\s*\\);`))?.[0] ?? "";
const migrationLines = (migration: string, pattern: RegExp) => (migration.match(pattern) ?? []).map(normalizeSql).sort();
const currentMigrationIndexes = (migration: string, model: string) => {
  const indexes = new Map<string, string>();
  for (const match of migration.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"]+)" ON "([^"]+)"[^;]*;/g)) {
    if (match[2] === model) indexes.set(match[1], normalizeSql(match[0]));
  }
  for (const match of migration.matchAll(/DROP INDEX "([^"]+)";/g)) indexes.delete(match[1]);
  return [...indexes.values()].sort();
};
const effectiveMigrationTriggers = (migration: string, model: string) => {
  const active = new Map<string, string>();
  const events = [
    ...[...migration.matchAll(/DROP TRIGGER "([^"]+)" ON "([^"]+)";/g)].map((match) => ({ index: match.index ?? -1, kind: "drop" as const, name: match[1], table: match[2] })),
    ...[...migration.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER "([^"]+)"/g)].map((match) => ({ index: match.index ?? -1, kind: "create" as const, name: match[1] }))
  ].sort((left, right) => left.index - right.index);
  for (const event of events) {
    if (event.kind === "drop") active.delete(`${event.table}|${event.name}`);
    else {
      const terminator = migration.indexOf(";", event.index);
      const statement = migration.slice(event.index, terminator + 1);
      const table = statement.match(/\sON "([^"]+)"/u)?.[1];
      if (!table) throw new Error(`unparseable_global_security_trigger:${event.name}`);
      active.set(`${table}|${event.name}`, normalizeSql(statement));
    }
  }
  return [...active.entries()].filter(([key]) => key.startsWith(`${model}|`)).map(([, statement]) => statement).sort();
};

const designPath = fileURLToPath(new URL("../../../docs/design/p1-3-global-security-protocol.json", import.meta.url));

describe("P1-3 global security design gate", () => {
  it("freezes the complete non-partial protocol state, route cutover, and privacy invariants", () => {
    const design = JSON.parse(readFileSync(designPath, "utf8")) as {
      version: number;
      programBoundary: string;
      models: string[];
      operationNamespace: string;
      databaseInvariants: Record<string, string[]>;
      retention: { incident: string };
      migrationOrdering: string[];
      releaseGate: { requiredCapabilities: string[]; forbiddenBeforeComplete: string[]; forbidsPartialRelease: boolean };
      routeInventory: Array<{ method: string; path: string; disposition: string; owner: string }>;
      transitionTable: Record<string, { states: string[]; terminalCodes: string[] }>;
      terminalOutcomes: { triples: string[] };
      operationReplaySemantics: { binding: string[]; unknownOutcome: string; tombstone: string };
      authorizationCarriers: {
        ordinary: { operationKeys: string[]; requires: string[]; forbids: string[] };
        recoveryReset: { operationKeys: string[]; requires: string[]; forbids: string[]; successfulResetClosure: string[] };
      };
      staleFinalization: { operationKeys: string[]; exactOutcome: string; requires: string[]; forbids: string[] };
      phase2AuthorizationBoundary: { capture: string; transaction: string; reauthorization: string; mutation: string; routeExposure: string };
      phase3FreshAuthBoundary: { operationIdentity: string; issueOrder: string[]; replay: string; status: string; consumption: string; routeExposure: string };
      phase4PasswordTransitionBoundary: { hash: string; transactionWrites: string[]; terminalOutcome: string; postCommit: string; routeExposure: string; credentialMutationReceipt: string; privilegeBoundary: string; deploymentRoleLifecycle: string };
      recoveryExpiryFinalization: { function: string; outcome: string; requires: string[]; writes: string[] };
      phase1Terminalization: { enabled: string[]; reserved: string[]; versionAttribution: string[] };
      freshAuthPurposeMatrix: Record<string, string>;
      versionVector: { fields: string[]; operationKeys: string[]; currentRule: string; staleRule: string };
      tombstoneAuthority: { phase1: string; insertion: string; statusReader: string; futureGate: string };
      persistenceParityEnums: Record<string, string>;
      persistenceParity: Record<string, { prismaModel: string; migrationTable: string; indexes: string[]; constraints: string[]; triggers: string[] }>;
      persistenceContract: Record<string, { key: string; fields: string[]; checks: string[] }>;
      modelLifecycleMatrix: Record<string, { states: string[]; lock: string; write: string; retention: string; compaction: string }>;
      sqlProtocol: { advisoryLock: { function: string; sql: string; writers: string[] }; transitionSerialization: { function: string; triggerNamePrefix: string; scope: string; tables: string[]; proof: string }; liveIdentityTables: string[]; uniqueIndexes: string[]; insertGuards: Array<{ trigger: string; event: string; requires: string[] }>; transitionGuards: Array<{ trigger: string; event: string; states: string }>; retentionProtection: { directDelete: string; truncate: string; accountDeletion: string }; compaction: { policy: string; bindingLeaseMinutes: number; deleteAuthorization: string; futureGate: string } };
      routeCutover: { phase: string; phase1Boundary: string; denyOrWrap: string[]; directAllowlist: string[]; wrappedAllowlist: string[]; callbackAllowlist: string[]; fallback: string };
      sessionPolicy: { idleDays: number; absoluteDays: number; qualifyingUse: string[]; excludedUse: string[]; lifetime: Record<string, unknown> };
      throttling: { layers: string[]; failures: number; windowMinutes: number; recoveryAtLeastAsStrong: boolean; layerOwnerMatrix: Record<string, string> };
      privateHistory: { phase1InsertMatrix: string[]; phase1Projection: string; reservedEventClasses: string[] };
      recovery: { codeCount: number; entropyBits: number; format: { alphabet: string; groups: number[]; normalization: string }; enrollmentState: string[]; kdf: Record<string, unknown>; restrictedSession: boolean; restrictedSessionMinutes: number; normalSignInRequired: boolean; everyUserRehearsalRequired: boolean; setIssuanceSerialization: string };
      recoveryPersistence: { setStates: string[]; codeOrdinalRange: [number, number]; codeConsumptionPurposes: string[]; readiness: string; sessionCarrier: string; kdfStorage: { saltBytes: number; derivedKeyBytes: number; plaintext: string } };
      emailChange: { states: string[]; featureGated: boolean; globalUserOnly: boolean; oldInviterNoticeWithoutNewAddress: boolean; revokeEveryOtherSession: boolean; currentAuthorization: { activeSessionRequired: boolean; currentCredentialVersionRequired: boolean; issuedUnexpiredGrantRequiredAtInitiation: boolean; nonRevokedGrantEvidenceRequiredAfterInitiation: boolean; submittedOperationBindingRequired: boolean; passiveExpiryRequiresDeadline: boolean; verifiedCanExpirePassively: boolean } };
      phase6EmailChangeAddendum: Record<string, unknown>;
      phase7SessionSecurityAddendum: {
        authorization: { scope: string; carrier: string; household: string; operationKey: string };
        projection: { fields: string[]; forbidden: string[]; handle: { algorithm: string; payload: string; encoding: string; key: string; serverOnly: boolean } };
        revocation: { scopes: string[]; confirmation: string; targetHandle: { requiredFor: string[]; forbiddenFor: string[] }; currentSession: string; outcomes: string[]; replayStates: string[]; unknown: string };
        freshAuth: { purpose: string; authentication: string; binding: string[] };
        database: { clock: string; lockOrder: string[]; directRuntimeDml: string };
        activity: { idleDays: number; absoluteDays: number; qualifyingUse: string[]; excludedUse: string[]; warning: string; rotation: string; cache: string; issuanceSessionSecurityVersion: Record<string, unknown> };
        privateEvents: { scope: string; eventClass: string; payload: string };
        readiness: { serverBoundary: string; requires: string[]; forbiddenUntilReady: string[] };
      };
    };

    expect(design.version).toBe(1);
    expect(design.programBoundary).toBe("complete_non_releasable_global_security_protocol");
    expect(design.models).toEqual(expect.arrayContaining([
      "AccountSecurityState", "FreshAuthGrant", "RecoveryCodeSet", "RecoveryCode", "RecoverySession",
      "GlobalSecurityOperationBinding", "GlobalSecurityOperation", "GlobalSecurityOperationTombstone",
      "GlobalSecurityOperationReservationTombstone", "GlobalSecurityEvent", "GlobalSecurityIncident", "EmailChange",
      "PasswordChangeCredentialMutation", "RecoveryResetCredentialMutation", "SessionSecurityActivity"
    ]));
    expect(design.operationNamespace).toBe("global_security");
    expect(design.databaseInvariants).toMatchObject({
      userOwnedForeignKeys: expect.arrayContaining(["user_owned_rows_reference_user_id"]),
      accountNeutralRows: ["GlobalSecurityIncident_user_id_nullable_for_client_and_deployment_layers"],
      operationIdentity: expect.arrayContaining(["user_id_operation_id_unique", "binding_claim_one_to_one"]),
      immutability: expect.arrayContaining(["private_event_append_only", "terminal_and_tombstone_write_once"])
    });
    expect(design.persistenceContract).toMatchObject({
      AccountSecurityState: { key: "user_id_primary", fields: expect.arrayContaining(["credential_version", "session_security_version"]) },
      GlobalSecurityOperationBinding: { key: "user_id_operation_id_unique", checks: expect.arrayContaining(["binding_claim_one_to_one", "lifetime_reservation"]) },
      GlobalSecurityOperationTombstone: { checks: expect.arrayContaining(["identity_preserving_compaction", "no_gap_after_compaction"]) },
      GlobalSecurityEvent: { checks: expect.arrayContaining(["append_only", "user_only_reader", "no_secret_fields"]) }
    });
    expect(Object.keys(design.persistenceContract).sort()).toEqual([...design.models].sort());
    expect(Object.keys(design.modelLifecycleMatrix).sort()).toEqual([...design.models].sort());
    expect(design.retention.incident).toBe("user_bound_until_account_deletion_account_neutral_until_future_maintenance_gate");
    expect(design.modelLifecycleMatrix.GlobalSecurityIncident.retention).toBe("user_bound_until_account_deletion_account_neutral_until_future_maintenance_gate");
    for (const model of design.models) {
      expect(design.modelLifecycleMatrix[model]).toMatchObject({ lock: expect.any(String), write: expect.any(String), retention: expect.any(String), compaction: expect.any(String) });
      expect(design.modelLifecycleMatrix[model].states.length).toBeGreaterThan(0);
    }
    expect(design.sqlProtocol.advisoryLock).toMatchObject({ function: "lock_global_security_operation_identity_v1(user_id, operation_id)", writers: ["issue", "submit", "status", "reservation_expiry", "compaction", "direct_sql_trigger"] });
    expect(design.sqlProtocol.advisoryLock.sql).toContain("pg_advisory_xact_lock");
    expect(design.sqlProtocol.transitionSerialization).toEqual({ function: "lock_global_security_transition_v1", triggerNamePrefix: "00_", scope: "deployment_global_before_statement_row_locks", tables: ["GlobalSecurityOperation", "GlobalSecurityOperationBinding", "FreshAuthGrant", "RecoveryCodeSet", "RecoveryCode", "RecoverySession", "EmailChange"], proof: "pg_blocking_pids_observed" });
    expect(design.sqlProtocol.liveIdentityTables).toEqual(["GlobalSecurityOperationBinding", "GlobalSecurityOperation", "GlobalSecurityOperationTombstone", "GlobalSecurityOperationReservationTombstone"]);
    expect(design.sqlProtocol.uniqueIndexes).toHaveLength(4);
    expect(design.sqlProtocol.insertGuards.map(({ trigger }) => trigger)).toEqual(["GlobalSecurityBinding_identity_insert_guard", "GlobalSecurityOperation_binding_claim_guard", "GlobalSecurityReservationTombstone_insert_guard", "GlobalSecurityTombstone_insert_guard", "AccountSecurityState_version_guard", "FreshAuthGrant_initial_state_guard", "RecoveryCode_initial_state_guard", "RecoverySession_initial_state_guard", "EmailChange_initial_state_guard", "GlobalSecurityIncident_initial_state_guard", "SessionSecurityActivity_initial_state_guard"]);
    expect(design.sqlProtocol.transitionGuards.map(({ trigger }) => trigger)).toEqual(["GlobalSecurityBinding_write_once", "GlobalSecurityOperation_terminal_write_once", "GlobalSecurityOperationTombstone_write_once", "GlobalSecurityReservationTombstone_write_once", "GlobalSecurityEvent_append_only", "AccountSecurityState_version_guard", "FreshAuthGrant_state_guard", "RecoveryCode_single_consume", "RecoverySession_state_guard", "EmailChange_state_guard", "GlobalSecurityIncident_state_guard", "SessionSecurityActivity_write_once"]);
    expect(design.sqlProtocol.retentionProtection).toEqual({ directDelete: "reject_while_user_exists", truncate: "reject_all_retained_tables", accountDeletion: "user_fk_cascade_only" });
    expect(design.sqlProtocol.compaction).toEqual({ policy: "no_automatic_compaction", bindingLeaseMinutes: 10, deleteAuthorization: "all_live_operation_binding_and_tombstone_deletes_rejected_until_global_account_deletion", futureGate: "separate_retention_and_maintenance_role_decision_required" });
    expect(design.migrationOrdering).toEqual(expect.arrayContaining(["security_state_before_operations", "operations_before_routes", "cutover_before_user_facing_release"]));
    expect(design.releaseGate).toMatchObject({ forbidsPartialRelease: true });
    expect(design.releaseGate.requiredCapabilities).toEqual(["fresh_grant", "password_transition", "offline_recovery", "email_change", "private_sessions", "private_history", "layered_throttling"]);
    expect(design.releaseGate.forbiddenBeforeComplete).toEqual(["password_change_ui", "recovery_code_ui", "foundation_only_release", "generic_better_auth_security_endpoints"]);
    expect(design.routeInventory.map(({ method, path, owner, disposition }) => `${method} ${path}|${owner}|${disposition}`)).toEqual([
      "POST /sign-in/social|better_auth_sign_in_social|deny", "GET /callback/:id|better_auth_callback_oauth|deny", "POST /callback/:id|better_auth_callback_oauth|deny", "GET /get-session|better_auth_session|deny_or_wrap", "POST /sign-out|better_auth_session|deny_or_wrap", "POST /sign-up/email|better_auth_sign_up_email|deny_until_cubby_initial_credential_protocol", "POST /sign-in/email|better_auth_sign_in_email|allow", "POST /reset-password|better_auth_password|deny_or_wrap", "POST /verify-password|better_auth_update_user|deny_or_wrap", "GET /verify-email|better_auth_password|deny_or_wrap", "POST /send-verification-email|better_auth_password|deny_or_wrap", "POST /change-email|better_auth_update_user|deny_or_wrap", "POST /change-password|better_auth_change_password|deny_or_wrap", "POST /set-password|better_auth_update_user|deny_or_wrap", "POST /update-session|better_auth_session|deny_or_wrap", "POST /update-user|better_auth_update_user|deny_or_wrap", "POST /delete-user|better_auth_update_user|deny", "POST /request-password-reset|better_auth_password|deny_or_wrap", "GET /reset-password/:token|better_auth_password_callback|deny", "GET /list-sessions|better_auth_session|deny_or_wrap", "POST /revoke-session|better_auth_session|deny_or_wrap", "POST /revoke-sessions|better_auth_session|deny_or_wrap", "POST /revoke-other-sessions|better_auth_session|deny_or_wrap", "POST /link-social|better_auth_account|deny", "GET /list-user-accounts|better_auth_account|deny", "GET /delete-user/:token|better_auth_delete_user_callback|deny", "POST /unlink-account|better_auth_account|deny", "POST /refresh-token|better_auth_token|deny", "GET /get-access-token|better_auth_token|deny", "GET /account-info|better_auth_account|deny", "GET /ok|better_auth_ok|deny", "GET /error|better_auth_error|deny"
    ]);
    expect(design.transitionTable.password_change.terminalCodes).toEqual(expect.arrayContaining(["changed", "stale_security_version", "grant_expired"]));
    expect(design.transitionTable.recovery_reset.states).toEqual(expect.arrayContaining(["restricted", "consumed", "closed", "expired"]));
    expect(design.transitionTable.recovery_reset.terminalCodes).toEqual(expect.arrayContaining(["recovery_session_expired"]));
    expect(design.terminalOutcomes.triples).toEqual(expect.arrayContaining(["recovery_reset|rejected|recovery_session_expired"]));
    expect(design.recoveryExpiryFinalization).toEqual({ function: "expire_recovery_session_finalization", outcome: "rejected|recovery_session_expired", requires: ["restricted_matching_submitted_recovery_session", "wall_clock_expiry", "no_protected_mutation"], writes: ["operation_terminal", "binding_terminal", "recovery_session_expired"] });
    expect(design.operationReplaySemantics).toMatchObject({ unknownOutcome: "authoritative_status_required", tombstone: "identity_preserving_compaction" });
    expect(design.authorizationCarriers).toEqual({
      ordinary: {
        operationKeys: ["password_change", "recovery_enrollment", "email_change", "session_revoke"],
        requires: ["same_user_active_ordinary_session", "current_account_security_version"],
        forbids: ["recovery_session"]
      },
      recoveryReset: {
        operationKeys: ["recovery_reset"],
        requires: ["same_user_recovery_session", "matching_operation_id", "recovery_reset_purpose", "restricted_state", "unexpired", "current_account_security_version"],
        forbids: ["ordinary_session", "ordinary_session_issuance", "household_access", "non_recovery_operation_authority"],
        successfulResetClosure: ["terminal_reset_completed", "binding_terminal", "recovery_session_consumed_or_closed", "ordinary_sign_in_required"]
      }
    });
    expect(design.staleFinalization).toEqual({
      operationKeys: ["password_change", "recovery_reset", "session_revoke"],
      exactOutcome: "stale|stale_security_version",
      requires: ["account_security_version_differs_from_bound_version", "locked_matching_binding_operation_identity", "submitted_binding", "operation_appropriate_carrier_identity"],
      forbids: ["protected_mutation", "alternate_terminal_status", "alternate_outcome_code", "current_version_false_stale"]
    });
    expect(design.phase2AuthorizationBoundary).toEqual({ capture: "server_session_user_and_session_id_only", transaction: "serializable", reauthorization: "both_version_components_equal_or_stale_security_version", mutation: "callback_only_after_in_transaction_reauthorization", routeExposure: "none" });
    expect(design.phase3FreshAuthBoundary).toEqual({ operationIdentity: "gso_crockford_26_database_enforced", issueOrder: ["reauthorize", "current_password_verify", "binding_open", "operation_pending", "grant_issued", "binding_submitted"], replay: "matching_submitted_unexpired_grant_only_without_password_reverify", status: "matching_binding_and_grant_only_with_expired_state_durably_terminalized", consumption: "matching_submitted_pending_operation_and_current_two_component_vector_only", routeExposure: "none", passwordAttestation: { algorithm: "hmac_sha256", payloadVersion: "fresh-auth-attestation-v1", keyLifecycle: "active_plus_one_prior_for_ten_minute_overlap", nonce: "32_random_bytes_base64url_unique_write_once", replacementHashBinding: "sha256_of_exact_better_auth_password_hash", runtimeDatabaseThreat: "direct_cubby_runtime_sql_cannot_issue_password_change_grant_without_valid_attestation", protectedPurposes: ["password_change", "recovery_enrollment"] } });
    expect(design.phase4PasswordTransitionBoundary).toEqual({ hash: "before_serializable_transaction_with_better_auth_compatible_hasher", transactionWrites: ["grant_consumed", "credential_hash_replaced", "both_versions_advanced_attributed", "all_sessions_and_activity_revoked", "operation_completed_changed", "binding_terminal", "content_free_completed_event"], terminalOutcome: "completed|changed", postCommit: "normal_new_password_sign_in_required", routeExposure: "none", credentialMutationReceipt: "security_definer_password_transition_procedure_with_attested_exact_replacement_hash_and_runtime_direct_write_denial", privilegeBoundary: "direct_cubby_runtime_sql_requires_owner_key_verified_one_time_password_attestation_and_cannot_substitute_replacement_hash", deploymentRoleLifecycle: "startup_provisions_runtime_role_then_migrates_then_owner_reconciles_versioned_attestation_keyring_before_unsetting_migration_secrets_and_starting_server" });
    expect(design.phase1Terminalization).toEqual({
      enabled: ["rejected", "stale_security_version"],
      reserved: ["completed_until_operation_specific_effect_gate"],
      versionAttribution: ["credential_version_change_requires_operation_id", "session_security_version_change_requires_operation_id", "stale_rejects_same_operation_attribution"]
    });
    expect(design.freshAuthPurposeMatrix).toEqual({ password_change: "password_change", recovery_enrollment: "recovery_enrollment", email_change: "email_change", session_revoke: "session_revoke", recovery_reset: "restricted_recovery_session_only" });
    expect(design.versionVector).toEqual({ fields: ["credential_version", "session_security_version"], operationKeys: ["password_change", "recovery_enrollment", "recovery_reset", "email_change", "session_revoke"], currentRule: "both_equal_bound_vector", staleRule: "either_component_differs" });
    expect(design.tombstoneAuthority).toEqual({ phase1: "inactive_reserved_schema", insertion: "rejected", statusReader: "live_binding_and_operation_only", futureGate: "atomic_single_authority_compaction_protocol" });
    expect(design.routeCutover.phase).toBe("phase4_signin_only_fail_closed");
    expect(design.routeCutover.phase1Boundary).toBe("route_enforcement_active_without_user_facing_security_flow");
    expect(design.routeCutover.denyOrWrap).toEqual(expect.arrayContaining([
      "change-password", "request-password-reset", "reset-password", "verify-password",
      "get-session", "list-sessions", "revoke-session", "revoke-other-sessions", "revoke-sessions", "sign-out"
    ]));
    expect(design.routeCutover).toMatchObject({ directAllowlist: ["POST /sign-in/email"], wrappedAllowlist: [], callbackAllowlist: [], fallback: "deny_before_toNextJsHandler" });
    expect(design.sessionPolicy).toMatchObject({ idleDays: 30, absoluteDays: 90 });
    expect(design.sessionPolicy.qualifyingUse).toEqual(["successful_explicitly_allowlisted_foreground_document_navigation", "successful_cubby_owned_non_GET_mutation_commit", "successful_private_security_action"]);
    expect(design.sessionPolicy.excludedUse).toEqual(expect.arrayContaining([
      "all_other_requests", "failed", "public_static", "health", "telemetry", "worker", "maintenance", "background", "prefetch"
    ]));
    expect(design.throttling).toMatchObject({ layers: ["account_identifier", "client", "deployment"], failures: 5, windowMinutes: 15, recoveryAtLeastAsStrong: true });
    expect(design.throttling.layerOwnerMatrix).toEqual({ account_identifier: "user_id_required", client: "user_id_forbidden_account_neutral", deployment: "user_id_forbidden_account_neutral" });
    expect(design.privateHistory.phase1InsertMatrix).toEqual(["operation_outcome|rejected", "operation_outcome|stale_security_version"]);
    expect(design.privateHistory.phase1Projection).toBe("empty_object_only");
    expect(design.privateHistory.reservedEventClasses).toEqual(["credential", "grant", "recovery", "email_change", "session", "throttle"]);
    expect(design.recovery).toMatchObject({ restrictedSession: true, normalSignInRequired: true, everyUserRehearsalRequired: true });
    expect(design.recovery.restrictedSessionMinutes).toBe(10);
    expect(design.recovery.setIssuanceSerialization).toBe("account_security_state_row");
    expect(design.recovery).toMatchObject({ codeCount: 10, entropyBits: 120, format: { alphabet: "crockford_base32", groups: [4, 4, 4, 4, 4, 4], normalization: "uppercase_strip_separators" }, kdf: { algorithm: "scrypt", N: 32768, r: 8, p: 1, saltBytes: 16, derivedKeyBytes: 32, parameterVersion: 1 } });
    expect(design.recovery.format.groups.reduce((total, width) => total + width, 0) * 5).toBe(design.recovery.entropyBits);
    expect(design.recoveryPersistence).toEqual({ setStates: ["generated", "save_acknowledged", "rehearsal_required", "rehearsed", "invalidated"], codeOrdinalRange: [1, 10], codeConsumptionPurposes: ["enrollment_rehearsal", "recovery_reset"], readiness: "exactly_one_enrollment_rehearsal_consumption_and_nine_active_codes", sessionCarrier: "recovery_reset_consumption_matching_rehearsed_set_and_operation", kdfStorage: { saltBytes: 16, derivedKeyBytes: 32, plaintext: "forbidden" } });
    expect(design.persistenceContract.RecoveryCodeSet).toEqual({ key: "user_id_set_version_primary", fields: ["issuance_operation_id", "fresh_auth_grant_id", "issuance_security_version", "issuance_session_security_version", "set_version", "state", "created_at", "updated_at"], checks: ["fresh_auth_recovery_enrollment_issuance", "exact_ten_retained_set_aggregate"] });
    expect(design.sqlProtocol.transitionSerialization.tables).toEqual(["GlobalSecurityOperation", "GlobalSecurityOperationBinding", "FreshAuthGrant", "RecoveryCodeSet", "RecoveryCode", "RecoverySession", "EmailChange"]);
    expect(design.modelLifecycleMatrix.RecoveryCodeSet).toEqual({ states: ["generated", "save_acknowledged", "rehearsal_required", "rehearsed", "invalidated"], lock: "transition_lock_then_user_security_state_then_recovery_set", write: "exact_ten_readiness_state_machine", retention: "until_account_deletion", compaction: "none" });
    const schema = readFileSync(schemaPath, "utf8");
    const migration = readFileSync(migrationPath, "utf8");
    const phase8Migration = readFileSync(phase8MigrationPath, "utf8");
    const currentMigrations = `${migration}\n${phase8Migration}`;
    expect(Object.keys(design.persistenceParity).sort()).toEqual(design.models.slice().sort());
    expect(Object.keys(design.persistenceParityEnums).sort()).toEqual([...globalSecurityEnums].sort());
    for (const name of globalSecurityEnums) {
      expect(design.persistenceParityEnums[name]).toBe(normalizeSql(schema.match(new RegExp(`enum ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? ""));
    }
    for (const model of design.models) {
      const parity = design.persistenceParity[model];
      expect(parity.prismaModel).toBe(normalizeSql(modelBlock(schema, model)));
      expect(parity.migrationTable).toBe(normalizeSql(migrationTable(migration, model)));
      expect(parity.indexes).toEqual(currentMigrationIndexes(currentMigrations, model));
      expect(parity.constraints).toEqual(migrationLines(currentMigrations, new RegExp(`ALTER TABLE "${model}" ADD CONSTRAINT "[^"]+"[^;]*;`, "g")));
      expect(parity.triggers).toEqual(effectiveMigrationTriggers(migration, model));
    }
    expect(design.transitionTable.recovery_enrollment.states).toEqual(design.recovery.enrollmentState);
    expect(design.transitionTable.email_change.states).toEqual(design.emailChange.states);
    expect(design.emailChange).toMatchObject({ featureGated: true, globalUserOnly: true, oldInviterNoticeWithoutNewAddress: true, revokeEveryOtherSession: true });
    expect(design.phase6EmailChangeAddendum).toMatchObject({
      models: ["EmailChangeDelivery", "EmailChangeIdentityMutation", "EmailChangeSessionRotation", "EmailDeliveryEncryptionKey"],
      delivery: { adapter: "smtp", readiness: "synthetic_accepted_receipt_required", payload: "aes_256_gcm_encrypted_database_outbox", keyring: "separate_versioned_keys_retained_while_referenced_by_nonterminal_delivery", states: ["queued", "dispatching", "accepted", "retryable_failed", "permanent_failed"], receipt: "sha256_message_id_plus_accepted_at", terminalPayload: "ciphertext_cleared", backup: "keys_excluded" },
      session: { success: "new_session_id_token_and_activity_all_old_sessions_revoked", statusCarrier: "successor_session_bound_by_rotation_receipt", cookieFailure: "revoke_all_sessions_require_new_email_sign_in" },
      closures: { failed: "rejected|delivery_failed_before_verification", abandoned: "rejected|abandoned_when_superseded", oldAddressNoticeFailure: "record_and_surface_without_rollback" },
      normalizedEmailUniqueness: "lower_btrim_database_unique",
      invitationReplacementSecrets: "encrypted_outbox_only_fresh_token_explicit_acceptance"
    });
    const phase6 = design.phase6EmailChangeAddendum as any;
    expect(Object.keys(phase6.persistence).sort()).toEqual(["EmailChangeDelivery", "EmailChangeIdentityMutation", "EmailChangeSessionRotation", "EmailDeliveryEncryptionKey"]);
    expect(phase6.persistence.EmailChangeDelivery).toMatchObject({ key: "id_primary", candidateKeys: ["email_change_id_kind_recipient_digest_unique"], directSql: "transition_guard_and_runtime_dispatch_procedures_only" });
    expect(phase6.persistence.EmailChangeDelivery.fields).toEqual(["user_id", "email_change_id", "operation_id", "kind", "recipient_digest", "state", "ciphertext", "iv", "auth_tag", "aad_digest", "key_version", "attempt_count", "lease_owner", "lease_expires_at", "next_attempt_at", "smtp_response_code", "message_id_digest", "accepted_at", "last_failure_code", "created_at", "updated_at"]);
    expect(phase6.persistence.EmailChangeDelivery.foreignKeys).toEqual(["user_id_to_user", "email_change_id_to_email_change", "user_id_operation_id_to_global_security_operation", "key_version_to_email_delivery_encryption_key_while_ciphertext_present"]);
    expect(phase6.persistence.EmailChangeDelivery.checks).toEqual(["encrypted_shape_nonterminal", "terminal_ciphertext_cleared", "attempt_count_0_to_8", "lease_shape_dispatching_only", "accepted_receipt_complete", "failure_code_closed"]);
    expect(phase6.persistence.EmailDeliveryEncryptionKey).toEqual({ key: "key_version_primary", fields: ["key_digest", "active_write", "created_at", "retired_at"], checks: ["sha256_digest_32_bytes", "exactly_one_active_write_key", "runtime_no_read_or_dml", "delete_rejected_while_ciphertext_references_version"], retention: "deployment_key_config_excluded_from_household_backup" });
    expect(phase6.persistence.EmailChangeIdentityMutation).toEqual({ key: "user_id_operation_id_primary", fields: ["old_email_digest", "new_email_digest", "created_at"], foreignKeys: ["user_id_operation_to_completed_email_change"], checks: ["digests_32_bytes", "immutable", "runtime_no_dml"], retention: "until_account_deletion" });
    expect(phase6.persistence.EmailChangeSessionRotation).toEqual({ key: "user_id_operation_id_primary", candidateKeys: ["successor_session_id_unique"], fields: ["old_session_id", "successor_session_id", "successor_token_digest", "activity_original_created_at", "cookie_state", "issued_at", "confirmed_at", "failed_at"], foreignKeys: ["user_id_operation_to_completed_email_change"], checks: ["token_digest_32_bytes", "cookie_state_timestamp_shape", "successor_identity_immutable", "successor_session_and_activity_required_at_insert_then_deletable_after_failed_cookie"], retention: "until_account_deletion" });
    expect(phase6.outbox.transitions).toEqual(["queued->dispatching", "dispatching->accepted", "dispatching->retryable_failed", "dispatching->permanent_failed", "retryable_failed->dispatching", "retryable_failed->permanent_failed"]);
    expect(phase6.outbox.lease).toEqual({ minutes: 5, owner: "random_worker_128_bit", acquire: "database_clock_skip_locked", expired: "dispatching_to_retryable_failed", maxAttempts: 8, retryMinutes: [1, 5, 15, 60, 240, 720, 1440] });
    expect(phase6.outbox.encryption).toEqual({ algorithm: "aes_256_gcm", ivBytes: 12, tagBytes: 16, aad: "version_byte_uint32_be_framed_utf8_fields_raw_recipient_digest_uint32_be_key_version", nonterminal: "ciphertext_iv_tag_aad_digest_key_version_required", terminal: "ciphertext_iv_tag_aad_digest_key_version_cleared_atomically" });
    expect(phase6.outbox.acceptedReceipt).toEqual({ smtpResponseCode: 250, acceptedRecipient: "exact_target_only", messageId: "ecv1_lowercase_base32_sha256_delivery_id_first26_at_mail_cubby_local", messageIdDigest: "sha256_utf8_length_framed_message_id", acceptedAt: "database_clock", consistency: "accepted_state_requires_all_receipt_fields" });
    expect(phase6.outbox.failureRegistry).toEqual({ retryable: ["smtp_connection", "smtp_rate_limited", "smtp_temporary", "smtp_timeout"], permanent: ["attempts_exhausted", "payload_decrypt", "receipt_invalid", "recipient_rejected", "smtp_auth", "smtp_rejected"], transition: "retryable_code_and_attempt_count_less_than_8_to_retryable_failed_else_permanent_failed_with_attempts_exhausted_on_retry_exhaustion" });
    expect(phase6.outbox.wireEncoding).toEqual({ aadVersion: 1, aadFields: ["delivery_id", "user_id", "operation_id", "kind", "recipient_digest"], fieldEncoding: "uint32_big_endian_byte_length_then_utf8_bytes_recipient_digest_raw_32_bytes", keyVersion: "uint32_big_endian_suffix", concatenation: "version_byte_then_framed_fields_then_key_version", messageId: "less_than_ecv1_dot_lowercase_base32_sha256_delivery_id_first_26_at_mail_dot_cubby_dot_local_greater_than" });
    expect(phase6.outbox.nonterminal).toEqual(["queued", "dispatching", "retryable_failed"]);
    expect(phase6.outbox.terminal).toEqual(["accepted", "permanent_failed"]);
    expect(phase6.outbox.duplicateSend).toBe("smtp_at_least_once_stable_deterministic_message_id_per_delivery");
    expect(phase6.outbox.permanentFailure).toBe("closed_failure_code_and_database_clock_ciphertext_clear");
    expect(phase6.keyLifecycle).toEqual({ config: "CUBBY_EMAIL_DELIVERY_KEYRING_plus_active_version", keyBytes: 32, storedDatabase: "sha256_digest_only_owner_managed", writeKey: "exactly_one_active", decryptKeys: "configured_versions_referenced_by_nonterminal_rows", rotation: "new_version_for_writes_old_versions_retained_until_zero_nonterminal_references", mismatch: "startup_fail_closed", householdBackup: ["key_config_excluded", "email_change_delivery_rows_excluded"], databaseRestore: "startup_requires_every_nonterminal_key_version_and_matching_digest" });
    expect(phase6.sessionRotation.receiptBinding).toEqual(["user", "operation", "old_session", "successor_session", "successor_token_digest", "activity_original_created_at", "issued_at"]);
    expect(phase6.sessionRotation.statusAuthorization).toBe("current_successor_session_matching_rotation_receipt_or_preterminal_original_session");
    expect(phase6.sessionRotation.oldSessionRule).toBe("all_old_session_ids_rejected_after_commit");
    expect(phase6.sessionRotation.transactionOrder).toEqual(["identity_mutation_receipt", "successor_session_create", "successor_activity_create", "old_sessions_delete", "old_activity_revoke", "both_versions_advance", "operation_complete", "binding_terminal", "rotation_receipt_issued", "content_free_events"]);
    expect(phase6.sessionRotation.cookieProtocol).toEqual({ issued: "postcommit_signed_better_auth_cookie_attempt", confirmed: "successor_cookie_authenticated_confirm_within_5_minutes", authenticatedTokenSource: "server_side_better_auth_http_only_session", unconfirmed: "database_clock_expiry_revokes_successor", emissionFailure: "mark_failed_revoke_successor_require_new_email_sign_in" });
    expect(phase6.lifecycleWorker).toEqual({ scheduleSeconds: 30, batchLimit: 100, clock: "postgresql_clock_timestamp", claim: "for_update_skip_locked_under_global_transition_lock", closures: ["pending_or_verified_email_change_expiry", "issued_unconfirmed_rotation_five_minute_expiry"] });
    expect(Object.keys(phase6.closureMatrix).sort()).toEqual(["abandoned", "failed", "oldAddressNoticeFailure", "stale"]);
    expect(phase6.closureMatrix.stale).toEqual({ from: ["pending", "verified"], cause: ["either_security_version_component_changed"], writes: ["email_change_failed", "grant_revoked_or_expired", "deliveries_terminalized_and_cleared", "operation_stale_security_version", "binding_terminal", "content_free_event"], forbids: ["user_email_update", "identity_mutation_receipt", "successor_session", "rotation_receipt"] });
    expect(phase6.closureMatrix.failed).toEqual({ from: ["pending"], cause: ["verification_delivery_permanent_failure"], writes: ["email_change_failed", "grant_revoked", "deliveries_terminalized_and_cleared", "operation_rejected_delivery_failed", "binding_terminal", "content_free_event"], forbids: ["user_email_update", "identity_mutation_receipt", "successor_session", "rotation_receipt"] });
    expect(phase6.closureMatrix.abandoned).toEqual({ from: ["pending", "verified"], cause: ["same_user_new_email_change_supersedes"], writes: ["email_change_abandoned", "grant_revoked", "verification_authority_invalidated_by_terminal_state", "deliveries_terminalized_and_cleared", "operation_rejected_abandoned", "binding_terminal", "content_free_event"], forbids: ["user_email_update", "identity_mutation_receipt", "successor_session", "rotation_receipt"] });
    expect(phase6.closureMatrix.oldAddressNoticeFailure).toEqual({ operationRemains: "completed_cutover_completed", delivery: "permanent_failed_ciphertext_cleared", surface: "private_status_delivery_warning_without_address" });
    expect(phase6.normalizedEmailReservation).toEqual({ function: "normalize_security_email_v1_lower_btrim_collate_C", userIndex: "unique_expression_on_normalize_security_email_v1_email", liveEmailChangeStates: ["pending", "verified"], serialization: "advisory_xact_lock_sha256_normalized_email_before_user_or_email_change_write", crossTableRule: "normalized_target_absent_from_users_and_other_live_email_changes", collision: "rejected_collision_rejected_non_enumerating" });
    expect(phase6.invitationRotation.replacement).toEqual(["same_household_role_inviter_remaining_expiry", "fresh_random_token", "stored_as_sha256_prefixed_digest_not_plaintext", "explicit_acceptance_required"]);
    expect(phase6.invitationRotation).toEqual({ scope: "all_pending_invites_recipient_old_normalized_email_across_households", lockOrder: "normalized_email_lock_then_invite_id_ascending", oldRows: "revoked_before_identity_cutover", replacement: ["same_household_role_inviter_remaining_expiry", "fresh_random_token", "stored_as_sha256_prefixed_digest_not_plaintext", "explicit_acceptance_required"], delivery: "raw_token_only_in_process_memory_then_encrypted_outbox", staleLink: "invalid_immediately_on_old_row_revoke", deliveryFailure: "replacement_invite_remains_pending_and_delivery_retries_then_private_warning", inviterNotice: "current_inviter_email_without_new_address_token_or_household_metadata" });
    expect(phase6.readiness.requires).toEqual(["smtp_synthetic_exact_recipient_250_receipt", "encrypted_outbox_acceptance_and_retry", "delivery_keyring_mismatch_and_restore_proof", "normalized_email_cross_table_race_proof", "identity_mutation_procedure_and_receipt", "invitation_reissue_stale_link_proof", "successor_session_cookie_confirm_and_failure_proof", "failed_abandoned_closure_proof", "private_projection_plaintext_exclusion", "all_phase6_exact_tree_reviews"]);
    expect(phase6.readiness.forbiddenUntilReady).toEqual(["email_change_api_routes", "email_change_server_actions", "email_change_settings_ui", "better_auth_change_email", "better_auth_verify_email", "better_auth_update_user"]);
    expect(design.emailChange.currentAuthorization).toEqual({ activeSessionRequired: true, currentCredentialVersionRequired: true, issuedUnexpiredGrantRequiredAtInitiation: true, nonRevokedGrantEvidenceRequiredAfterInitiation: true, submittedOperationBindingRequired: true, passiveExpiryRequiresDeadline: true, verifiedCanExpirePassively: true });
  });

  it("freezes the Phase 7 private global-session security boundary", () => {
    const design = JSON.parse(readFileSync(designPath, "utf8")) as {
      authorizationCarriers: { ordinary: { operationKeys: string[]; requires: string[]; forbids: string[] } };
      freshAuthPurposeMatrix: Record<string, string>;
      transitionTable: Record<string, { states: string[]; terminalCodes: string[] }>;
      sessionPolicy: { idleDays: number; absoluteDays: number; rotationPreservesOriginalAnchor: boolean; qualifyingUse: string[]; excludedUse: string[]; clock: string; cacheCannotOutliveAuthorization: boolean; lifetime: Record<string, unknown> };
      privateHistory: { scope: string; eventClasses: string[]; phase1Projection: string };
      routeCutover: { denyOrWrap: string[]; wrappedAllowlist: string[] };
      phase7SessionSecurityAddendum: {
        authorization: { scope: string; carrier: string; household: string; operationKey: string; replay: Record<string, unknown> };
        projection: { fields: string[]; forbidden: string[]; handle: { algorithm: string; payload: string; encoding: string; key: string; serverOnly: boolean } };
        revocation: { scopes: string[]; confirmation: string; targetHandle: { requiredFor: string[]; forbiddenFor: string[] }; scopeMapping: Record<string, unknown>; intentFingerprint: Record<string, unknown>; currentSession: string; outcomes: string[]; replayStates: string[]; unknown: string };
        freshAuth: { purpose: string; authentication: string; binding: string[]; attestation: Record<string, unknown> };
        database: { clock: string; lockOrder: string[]; directRuntimeDml: string };
        activity: { idleDays: number; absoluteDays: number; initialValues: Record<string, unknown>; lifetime: Record<string, unknown>; qualifyingUse: string[]; requestClasses: Record<string, unknown>; excludedUse: string[]; warning: Record<string, unknown>; rotation: Record<string, unknown>; cache: Record<string, unknown>; issuanceSessionSecurityVersion: Record<string, unknown> };
        privateEvents: { scope: string; eventClass: string; payload: string; emission: Record<string, unknown> };
        readiness: { serverBoundary: string; requires: string[]; evidence: string[]; forbiddenUntilReady: string[] };
      };
    };
    const phase7 = design.phase7SessionSecurityAddendum;

    expect(phase7.authorization).toEqual({
      scope: "global_user_only_independent_of_household",
      carrier: "same_user_active_ordinary_session_current_two_component_vector",
      household: "forbidden",
      operationKey: "session_revoke",
      replay: {
        oneAndOthers: "original_current_session_matching_submitted_binding_only",
        pendingRetryTarget: "database_locked_persisted_target_snapshot_not_mutable_live_session_enumeration",
        currentLostResponse: {
          statusOnly: true,
          requires: ["same_user_active_ordinary_session_after_normal_sign_in", "unchanged_two_component_vector", "matching_terminal_operation_receipt"],
          permits: ["terminal_receipt", "authoritative_status"],
          forbids: ["reexecution", "one_or_others_replay", "recovery_session"],
          normalSignInRequiredAfterLostResponse: true
        },
        allLostResponse: {
          statusOnly: true,
          requires: ["same_user_active_ordinary_session_after_normal_sign_in", "current_two_component_vector_advanced_by_operation", "last_session_security_operation_id_matches_operation"],
          permits: ["terminal_receipt", "authoritative_status"],
          forbids: ["reexecution", "one_or_others_replay", "recovery_session"],
          normalSignInRequiredAfterLostResponse: true
        }
      }
    });
    expect(design.authorizationCarriers.ordinary.operationKeys).toContain(phase7.authorization.operationKey);
    expect(design.authorizationCarriers.ordinary.requires).toEqual(["same_user_active_ordinary_session", "current_account_security_version"]);
    expect(design.authorizationCarriers.ordinary.forbids).toContain("recovery_session");
    expect(phase7.projection).toEqual({
      fields: ["handle", "is_current", "device_label", "created_at", "last_qualifying_at", "idle_warning_at", "expires_at"],
      forbidden: ["ip_address", "full_user_agent", "raw_token", "household", "baby", "internal_id"],
      handle: {
        algorithm: "hmac_sha256",
        payload: "length_prefixed_utf8_user_id_and_session_id",
        encoding: "base64url_first_22_bytes",
        key: "server_only_session_handle_key",
        serverOnly: true
      }
    });
    expect(phase7.revocation).toEqual({
      scopes: ["current", "one", "others", "all"],
      confirmation: "required_for_every_scope_before_submit",
      targetHandle: { requiredFor: ["current", "one"], forbiddenFor: ["others", "all"] },
      scopeMapping: {
        current: "only_current_session_requires_its_current_handle",
        one: "exactly_one_non_current_session_requires_target_handle",
        others: "all_non_current_sessions_requires_canonical_absent_target_sentinel",
        all: "all_sessions_including_current_requires_canonical_absent_target_sentinel"
      },
      intentFingerprint: {
        algorithm: "sha256",
        payload: "length_prefixed_utf8_scope_and_canonical_target_handle_or_absent_target_sentinel",
        canonicalAbsentTargetSentinel: "absent_target_handle",
        binds: ["scope", "canonical_target_handle_or_absent_target_sentinel"]
      },
      currentSession: "revoke_current_session_clear_cookie_redirect_login",
      outcomes: ["revoked", "already_revoked", "stale_security_version"],
      replayStates: ["submitted", "completed", "stale", "unknown"],
      unknown: "authoritative_status_reconciliation_without_reexecution"
    });
    expect(design.transitionTable.session_revoke).toEqual({
      states: phase7.revocation.replayStates,
      terminalCodes: phase7.revocation.outcomes
    });
    expect(phase7.freshAuth).toEqual({
      purpose: "session_revoke",
      authentication: "current_password_required",
      binding: ["user", "current_session", "credential_version", "session_security_version", "scope", "canonical_target_handle_or_absent_target_sentinel", "resolved_target_session_id_or_absent_target_sentinel", "opening_fingerprint", "intent_fingerprint"],
      attestation: {
        algorithm: "hmac_sha256",
        payloadVersion: "session-revoke-attestation-v1",
        keyLifecycle: "existing_fresh_auth_attestation_active_plus_one_prior_for_ten_minute_overlap",
        binds: ["user", "current_session", "operation", "purpose", "credential_version", "session_security_version", "scope", "canonical_target_handle_or_absent_target_sentinel", "resolved_target_session_id_or_absent_target_sentinel", "opening_fingerprint", "intent_fingerprint", "nonce", "key_version"],
        nonce: "32_random_bytes_base64url_unique_write_once",
        databaseVerification: "security_definer_procedure_verifies_attestation_before_session_revoke_mutation",
        runtimeCannotForge: "direct_cubby_runtime_sql_cannot_issue_or_substitute_valid_session_revoke_attestation"
      }
    });
    expect(design.freshAuthPurposeMatrix.session_revoke).toBe(phase7.freshAuth.purpose);
    expect(phase7.database).toEqual({
      clock: "postgresql_clock_timestamp",
      lockOrder: ["global_security_transition_lock", "user_security_state", "current_session", "target_sessions_by_session_id_ascending", "session_security_activity_by_session_id_ascending", "global_security_operation_identity"],
      directRuntimeDml: "cubby_runtime_direct_session_and_session_security_activity_dml_denied_security_definer_session_security_procedures_only"
    });
    expect(phase7.activity).toEqual({
      idleDays: 30,
      absoluteDays: 90,
      initialValues: { originalCreatedAt: "Session.createdAt", lastQualifyingAt: "Session.createdAt", idleWarningAt: "null", issuanceSessionSecurityVersion: "AccountSecurityState.sessionSecurityVersion" },
      lifetime: {
        effectiveExpiry: "min(Session.expiresAt,original_created_at_plus_90_days,last_qualifying_at_plus_30_days)",
        clockComparison: "postgresql_clock_timestamp_greater_than_or_equal_to_effective_expiry",
        lockAndRecheck: "immediately_before_protected_response_or_write_commit_lock_session_and_activity_recheck_expire_activity_delete_session_and_deny_if_crossed"
      },
      qualifyingUse: ["successful_explicitly_allowlisted_foreground_document_navigation", "successful_cubby_owned_non_GET_mutation_commit", "successful_private_security_action"],
      requestClasses: {
        foregroundDocumentNavigation: {
          method: "POST",
          carrier: "visible_post_render_client_report_after_authenticated_layout_hydration",
          body: { requestClass: "foreground_document_navigation" },
          route: "api_account_session_activity_exact_allowlist",
          success: "authenticated_protected_document_rendered_and_visible"
        },
        cubbyOwnedNonGetMutation: {
          methods: ["POST", "PUT", "PATCH", "DELETE"],
          route: "authenticated_cubby_owned_route_or_server_action",
          success: "transaction_commit_success_and_executed_this_invocation_not_terminal_replay"
        },
        privateSecurityAction: {
          methods: ["POST"],
          identity: "explicit_server_side_private_security_action_allowlist_not_request_header",
          success: "security_transaction_commit_success"
        },
        excludedHeaders: ["Purpose: prefetch", "Sec-Purpose: prefetch", "Sec-Fetch-Mode: no-cors"],
        default: "exclude_any_request_not_matching_a_qualifying_class"
      },
      excludedUse: ["all_other_requests", "failed", "public_static", "health", "telemetry", "worker", "maintenance", "background", "prefetch"],
      warning: {
        derivation: "effective_expiry_minus_7_days",
        firstObserved: "once_when_database_clock_is_at_or_after_warning_threshold_and_before_effective_expiry_set_idle_warning_at_to_clock_timestamp",
        neverExtendsActivity: true
      },
      rotation: { originalCreatedAt: "preserve_original_created_at_anchor", lastQualifyingAt: "preserve_existing_last_qualifying_at", neverResetsLifetime: true },
      issuanceSessionSecurityVersion: {
        ordinaryAndBackfill: "current_account_security_state_session_security_version_create_initial_state_if_absent",
        emailChangeSuccessor: "prior_email_change_session_security_version_plus_one_matching_guarded_cutover_only",
        immutable: true,
        authorization: "mismatch_revoke_active_activity_delete_session_deny",
        listing: "current_issuance_session_security_version_only"
      },
      cache: { disableCookieCache: true, authorization: "database_authorization_and_database_clock_lifetime_check_on_every_protected_request" }
    });
    expect(design.sessionPolicy).toEqual({
      idleDays: phase7.activity.idleDays,
      absoluteDays: phase7.activity.absoluteDays,
      rotationPreservesOriginalAnchor: true,
      qualifyingUse: phase7.activity.qualifyingUse,
      excludedUse: phase7.activity.excludedUse,
      clock: phase7.database.clock,
      cacheCannotOutliveAuthorization: true,
      lifetime: phase7.activity.lifetime
    });
    expect(phase7.privateEvents).toEqual({
      scope: "global_user_only",
      eventClass: "session",
      payload: "empty_object_only",
      emission: {
        neverFor: ["list", "warning", "activity"],
        exactlyOneFor: ["revoked", "already_revoked", "stale_security_version"],
        atomicWith: ["operation", "binding", "grant", "session", "activity"],
        event: "operation_outcome_empty_object_only"
      }
    });
    expect(design.privateHistory).toMatchObject({ scope: phase7.privateEvents.scope, phase1Projection: phase7.privateEvents.payload, eventClasses: expect.arrayContaining([phase7.privateEvents.eventClass]) });
    expect(phase7.readiness).toEqual({
      serverBoundary: "global_session_security_service_route_and_database_procedure_boundary",
      sourceActivation: { artifact: "docs/design/p1-3-phase7-readiness.json", authority: "phase7_source_readiness", state: "active_local_candidate", completeProgramRelease: "unreleased_until_phase9" },
      sourceActivationSatisfiesForbiddenUntilReady: true,
      requires: ["postgresql_global_user_authorization_and_direct_dml_denial", "postgresql_lock_order_and_concurrent_scope_replay", "database_verifiable_session_revoke_attestation_and_key_rotation", "browser_safe_projection_confirmation_current_signout_and_stale_cache_denial", "responsive_mobile_and_desktop_session_manager", "accessibility_keyboard_focus_live_region_and_confirmation", "all_phase7_exact_tree_reviews"],
      evidence: ["current_one_others_all_scope_mapping_and_replay_carrier_proof", "current_scope_survivor_authorization_and_post_signin_terminal_receipt_status_proof", "all_scope_advanced_vector_post_signin_terminal_receipt_status_proof", "same_session_submitted_pending_unknown_status_and_retry_proof", "atomic_authorization_and_safe_session_projection_proof", "production_document_mutation_private_security_qualifying_and_excluded_request_classification_proof", "before_and_after_expiry_lock_recheck_race_proof", "seven_day_warning_first_observed_and_non_extension_proof", "rotation_anchor_preservation_proof", "disable_cookie_cache_and_database_authorization_denial_proof", "operation_outcome_event_atomicity_proof", "responsive_mobile_and_desktop_session_manager_proof", "accessibility_keyboard_focus_live_region_and_confirmation_proof", "dual_independent_review_proof"],
      forbiddenUntilReady: ["global_session_security_api_routes", "global_session_security_server_actions", "global_session_security_settings_ui", "better_auth_list_sessions", "better_auth_revoke_session", "better_auth_revoke_other_sessions", "better_auth_revoke_sessions", "better_auth_sign_out"]
    });
    expect(design.routeCutover).toMatchObject({ denyOrWrap: expect.arrayContaining(["list-sessions", "revoke-session", "revoke-other-sessions", "revoke-sessions", "sign-out"]), wrappedAllowlist: [] });
  });
});
