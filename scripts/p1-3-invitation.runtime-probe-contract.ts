export const manualDiagnosticSteps = [
  "fixture", "create_reserve", "create_prepared_read", "create_submit", "create_token",
  "create_invite_read", "create_persistence", "create_status", "create_replay", "create_conflict",
  "replace_reserve", "replace_submit", "replace_token", "replace_read", "replace_status",
  "pending_create", "pending_claim", "single_revoke", "single_read", "bulk_create", "bulk_revoke", "bulk_read",
  "authority_reserve", "authority_disable", "authority_submit", "credentialless_classify", "postconditions"
] as const;
export type ManualDiagnosticStep = typeof manualDiagnosticSteps[number];
export const manualDiagnosticSqlStates = new Set(["42883", "42804", "42501", "42702", "23502", "23503", "23505", "23514", "22P02", "0A000", "55006", "P0001"]);
export const manualDiagnosticSqlRoutines = new Map([
  ["reserve_manual_invite_create_v2", "reserve_entry"],
  ["lock_invitation_protocol_v2", "protocol_lock"],
  ["lock_invitation_recipient_v2", "recipient_lock"],
  ["create_invitation_identity_v2", "identity"],
  ["write_invitation_binding_v2", "binding"],
  ["reauthorize_invitation_carrier_v2", "carrier"],
  ["assert_invitation_issuer_authority_v2", "authority"],
  ["digest", "digest"], ["hmac", "hmac"], ["make_interval", "interval"]
]);
const manualDiagnosticSqlPatterns = new Map([
  ["operator does not exist", "operator"],
  ["cannot cast", "cast"],
  ["cannot be cast", "cast"],
  ["type does not exist", "type"],
  ["extension", "extension"]
]);
const manualDiagnosticPermissionPatterns = new Map([
  ["permission denied for schema", "schema_usage"],
  ["permission denied for function", "function_execute"],
  ["permission denied for routine", "function_execute"],
  ["permission denied for relation", "relation"],
  ["permission denied for table", "relation"],
  ["permission denied for sequence", "sequence"],
  ["row-level security", "row_security"],
  ["must be owner of", "ownership"],
  ["permission denied to set role", "role_boundary"],
  ["must be member of role", "role_boundary"]
]);
const manualDiagnosticProtocolExceptions = new Map([
  ["invitation_submit_invalid", "submit_invalid"],
  ["invitation_operation_conflict", "operation_conflict"],
  ["invitation_carrier_invalid", "carrier_invalid"],
  ["invitation_attestation_key_invalid", "attestation_key_invalid"],
  ["invitation_attestation_mac_invalid", "attestation_mac_invalid"],
  ["invitation_session_invalid", "session_invalid"],
  ["invitation_membership_invalid", "membership_invalid"],
  ["invitation_subject_membership_invalid", "subject_membership_invalid"],
  ["invitation_attestation_replay_conflict", "attestation_replay_conflict"],
  ["invitation_issuer_forbidden", "issuer_forbidden"],
  ["invitation_terminal_result_invalid", "terminal_result_invalid"],
  ["invitation_audit_projection_invalid", "audit_projection_invalid"],
  ["invitation_operation_peer_occupancy_invalid", "operation_peer_occupancy_invalid"],
  ["invitation_presentation_occupancy_invalid", "presentation_occupancy_invalid"],
  ["invitation_operation_occupancy_invalid", "operation_occupancy_invalid"],
  ["invitation_revoke_unavailable", "revoke_unavailable"],
  ["invitation_lock_input_invalid", "lock_input_invalid"],
  ["invitation_reservation_invalid", "reservation_invalid"],
]);
const manualDiagnosticProtocolRoutines = new Map([
  ["submit_manual_invite_create_v2", "submit_entry"],
  ["reauthorize_invitation_carrier_v2", "carrier"],
  ["assert_invitation_issuer_authority_v2", "authority"],
  ["execute_invitation_domain_transition_v2", "transition"],
  ["write_invitation_terminal_result_v2", "terminal_result"],
  ["write_invitation_audit_v2", "audit"],
]);
const manualDiagnosticRevokeStages = new Map([
  ["invitation_single_revoke_stage_request_failed", "request"],
  ["invitation_single_revoke_stage_authority_failed", "authority"],
  ["invitation_single_revoke_stage_invite_transition_failed", "invite_transition"],
  ["invitation_single_revoke_stage_claim_close_failed", "claim_close"],
  ["invitation_single_revoke_stage_claim_lock_failed", "claim_lock"],
  ["invitation_single_revoke_stage_claim_delete_failed", "claim_delete"],
  ["invitation_single_revoke_stage_claim_tombstone_failed", "claim_tombstone"],
  ["invitation_single_revoke_stage_terminal_failed", "terminal"],
  ["invitation_single_revoke_stage_deferred_finalization_failed", "deferred_finalization"],
  ["invitation_bulk_revoke_stage_request_failed", "request"],
  ["invitation_bulk_revoke_stage_authority_failed", "authority"],
  ["invitation_bulk_revoke_stage_invite_transition_failed", "invite_transition"],
  ["invitation_bulk_revoke_stage_claim_close_failed", "claim_close"],
  ["invitation_bulk_revoke_stage_claim_lock_failed", "claim_lock"],
  ["invitation_bulk_revoke_stage_claim_delete_failed", "claim_delete"],
  ["invitation_bulk_revoke_stage_claim_tombstone_failed", "claim_tombstone"],
  ["invitation_bulk_revoke_stage_terminal_failed", "terminal"],
  ["invitation_bulk_revoke_stage_deferred_finalization_failed", "deferred_finalization"],
]);
export const manualDiagnosticCodes = new Set(manualDiagnosticSteps.flatMap((step) => [
  `p1_3_invitation_acceptance_check_${step}_failed`,
  ...Array.from(manualDiagnosticRevokeStages.values(), (stage) => `p1_3_invitation_acceptance_check_${step}_stage_${stage}_failed`),
  ...Array.from(manualDiagnosticSqlStates, (state) => `p1_3_invitation_acceptance_check_${step}_sql_${state.toLowerCase()}_failed`),
  ...Array.from(manualDiagnosticSqlStates, (state) => Array.from(manualDiagnosticRevokeStages.values(), (stage) => `p1_3_invitation_acceptance_check_${step}_sql_${state.toLowerCase()}_stage_${stage}_failed`)).flat(),
  ...Array.from(manualDiagnosticSqlRoutines.values(), (routine) => `p1_3_invitation_acceptance_check_${step}_sql_42883_${routine}_failed`),
  ...Array.from(manualDiagnosticSqlPatterns.values(), (category) => `p1_3_invitation_acceptance_check_${step}_sql_42883_${category}_failed`),
  ...Array.from(manualDiagnosticPermissionPatterns.values(), (category) => `p1_3_invitation_acceptance_check_${step}_sql_42501_${category}_failed`),
  ...Array.from(manualDiagnosticProtocolExceptions.values(), (identity) => `p1_3_invitation_acceptance_check_${step}_sql_p0001_${identity}_failed`),
  ...Array.from(manualDiagnosticProtocolRoutines.values(), (identity) => `p1_3_invitation_acceptance_check_${step}_sql_p0001_${identity}_failed`)
]));

export function manualDiagnosticSqlCode(step: ManualDiagnosticStep, error: unknown) {
  const meta = error && typeof error === "object" ? (error as { meta?: { code?: unknown; message?: unknown } }).meta : null;
  const message = `${typeof meta?.message === "string" ? meta.message : ""}\n${error instanceof Error ? error.message : ""}`.toLowerCase();
  const messageException = [...manualDiagnosticProtocolExceptions].find(([pattern]) => message.includes(pattern))?.[1];
  const revokeStage = [...manualDiagnosticRevokeStages].find(([pattern]) => message.includes(pattern))?.[1];
  if ((!meta || typeof meta.code !== "string" || !manualDiagnosticSqlStates.has(meta.code)) && revokeStage) {
    return `p1_3_invitation_acceptance_check_${step}_stage_${revokeStage}_failed`;
  }
  if ((!meta || typeof meta.code !== "string" || !manualDiagnosticSqlStates.has(meta.code)) && messageException) {
    return `p1_3_invitation_acceptance_check_${step}_sql_p0001_${messageException}_failed`;
  }
  if (!meta || typeof meta.code !== "string" || !manualDiagnosticSqlStates.has(meta.code)) return null;
  if (revokeStage) return `p1_3_invitation_acceptance_check_${step}_sql_${meta.code.toLowerCase()}_stage_${revokeStage}_failed`;
  if (meta.code === "42883") {
    const routine = [...manualDiagnosticSqlRoutines].find(([name]) => message.includes(name.toLowerCase()))?.[1];
    if (routine) return `p1_3_invitation_acceptance_check_${step}_sql_42883_${routine}_failed`;
    const category = [...manualDiagnosticSqlPatterns].find(([pattern]) => message.includes(pattern))?.[1];
    if (category) return `p1_3_invitation_acceptance_check_${step}_sql_42883_${category}_failed`;
  }
  if (meta.code === "42501") {
    const category = [...manualDiagnosticPermissionPatterns].find(([pattern]) => message.includes(pattern))?.[1];
    if (category) return `p1_3_invitation_acceptance_check_${step}_sql_42501_${category}_failed`;
  }
  if (meta.code === "P0001") {
    const exception = [...manualDiagnosticProtocolExceptions].find(([pattern]) => message.includes(pattern))?.[1];
    if (exception) return `p1_3_invitation_acceptance_check_${step}_sql_p0001_${exception}_failed`;
    const routine = [...manualDiagnosticProtocolRoutines].find(([pattern]) => message.includes(pattern))?.[1];
    if (routine) return `p1_3_invitation_acceptance_check_${step}_sql_p0001_${routine}_failed`;
  }
  return `p1_3_invitation_acceptance_check_${step}_sql_${meta.code.toLowerCase()}_failed`;
}

export type P13ManualManagementAcceptance = {
  create: { preparedIdentity: boolean; preparedBinding: boolean; preparedPayload: boolean; inviteCount: number; terminalResultCount: number; auditCount: number };
  createSubmit: { pendingInviteCount: number; terminalResultCount: number; auditCount: number; rawTokenOnlyInInitialResponse: boolean; tokenHashLocatesInvite: boolean; statusDoesNotRediscloseToken: boolean };
  createReplay: { duplicateInviteCount: number; unchangedAuditCount: boolean; changedIntentConflictedWithoutMutation: boolean };
  replace: { predecessorRevoked: boolean; successorVersionIncremented: boolean; successorTokenOnlyInInitialResponse: boolean; terminalResultCount: number; auditCount: number };
  revoke: { exactTargetTerminalized: boolean; claimClosed: boolean; auditCount: number };
  revokeAll: { exactPendingTargetsTerminalized: boolean; claimsClosed: boolean; auditCount: number };
  authorityLoss: { failedClosed: boolean; noSuccessEffects: boolean };
  privacy: { rawTokenAbsentFromPersistence: boolean; rawTokenAbsentFromAuditAndStatus: boolean; credentiallessExistingUserDenied: boolean };
  householdDeletion: { absentAndFailClosed: boolean };
};

export const manualManagementPostconditionCodes = new Set([
  "p1_3_invitation_acceptance_runtime_postcondition_create_prepared_identity_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_prepared_binding_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_prepared_payload_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_invite_count_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_terminal_result_count_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_audit_count_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_submit_pending_invite_count_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_submit_terminal_result_count_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_submit_audit_count_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_submit_raw_token_initial_response_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_submit_token_hash_lookup_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_status_token_redisclosure_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_replay_duplicate_invite_count_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_replay_audit_count_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_create_replay_changed_intent_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_replace_predecessor_revoked_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_replace_successor_version_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_replace_token_initial_response_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_replace_terminal_result_count_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_replace_audit_count_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_revoke_target_terminalized_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_revoke_claim_closed_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_revoke_audit_count_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_bulk_revoke_targets_terminalized_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_bulk_revoke_claims_closed_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_bulk_revoke_audit_count_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_authority_loss_failed_closed_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_authority_loss_effects_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_privacy_persistence_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_privacy_audit_status_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_privacy_credentialless_invalid",
  "p1_3_invitation_acceptance_runtime_postcondition_household_deletion_invalid",
]);

/** Pure gate for the concrete postcondition reads collected by the isolated runtime probe. */
export function validateManualManagementAcceptance(value: P13ManualManagementAcceptance) {
  const checks = [
    ["p1_3_invitation_acceptance_runtime_postcondition_create_prepared_identity_invalid", value.create.preparedIdentity],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_prepared_binding_invalid", value.create.preparedBinding],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_prepared_payload_invalid", value.create.preparedPayload],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_invite_count_invalid", value.create.inviteCount === 0],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_terminal_result_count_invalid", value.create.terminalResultCount === 0],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_audit_count_invalid", value.create.auditCount === 0],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_submit_pending_invite_count_invalid", value.createSubmit.pendingInviteCount === 1],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_submit_terminal_result_count_invalid", value.createSubmit.terminalResultCount === 1],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_submit_audit_count_invalid", value.createSubmit.auditCount === 1],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_submit_raw_token_initial_response_invalid", value.createSubmit.rawTokenOnlyInInitialResponse],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_submit_token_hash_lookup_invalid", value.createSubmit.tokenHashLocatesInvite],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_status_token_redisclosure_invalid", value.createSubmit.statusDoesNotRediscloseToken],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_replay_duplicate_invite_count_invalid", value.createReplay.duplicateInviteCount === 0],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_replay_audit_count_invalid", value.createReplay.unchangedAuditCount],
    ["p1_3_invitation_acceptance_runtime_postcondition_create_replay_changed_intent_invalid", value.createReplay.changedIntentConflictedWithoutMutation],
    ["p1_3_invitation_acceptance_runtime_postcondition_replace_predecessor_revoked_invalid", value.replace.predecessorRevoked],
    ["p1_3_invitation_acceptance_runtime_postcondition_replace_successor_version_invalid", value.replace.successorVersionIncremented],
    ["p1_3_invitation_acceptance_runtime_postcondition_replace_token_initial_response_invalid", value.replace.successorTokenOnlyInInitialResponse],
    ["p1_3_invitation_acceptance_runtime_postcondition_replace_terminal_result_count_invalid", value.replace.terminalResultCount === 1],
    ["p1_3_invitation_acceptance_runtime_postcondition_replace_audit_count_invalid", value.replace.auditCount === 1],
    ["p1_3_invitation_acceptance_runtime_postcondition_revoke_target_terminalized_invalid", value.revoke.exactTargetTerminalized],
    ["p1_3_invitation_acceptance_runtime_postcondition_revoke_claim_closed_invalid", value.revoke.claimClosed],
    ["p1_3_invitation_acceptance_runtime_postcondition_revoke_audit_count_invalid", value.revoke.auditCount === 1],
    ["p1_3_invitation_acceptance_runtime_postcondition_bulk_revoke_targets_terminalized_invalid", value.revokeAll.exactPendingTargetsTerminalized],
    ["p1_3_invitation_acceptance_runtime_postcondition_bulk_revoke_claims_closed_invalid", value.revokeAll.claimsClosed],
    ["p1_3_invitation_acceptance_runtime_postcondition_bulk_revoke_audit_count_invalid", value.revokeAll.auditCount === 1],
    ["p1_3_invitation_acceptance_runtime_postcondition_authority_loss_failed_closed_invalid", value.authorityLoss.failedClosed],
    ["p1_3_invitation_acceptance_runtime_postcondition_authority_loss_effects_invalid", value.authorityLoss.noSuccessEffects],
    ["p1_3_invitation_acceptance_runtime_postcondition_privacy_persistence_invalid", value.privacy.rawTokenAbsentFromPersistence],
    ["p1_3_invitation_acceptance_runtime_postcondition_privacy_audit_status_invalid", value.privacy.rawTokenAbsentFromAuditAndStatus],
    ["p1_3_invitation_acceptance_runtime_postcondition_privacy_credentialless_invalid", value.privacy.credentiallessExistingUserDenied],
    ["p1_3_invitation_acceptance_runtime_postcondition_household_deletion_invalid", value.householdDeletion.absentAndFailClosed],
  ] as const;
  const failure = checks.find(([, valid]) => !valid);
  if (failure) throw new Error(failure[0]);
}
