import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createSmtpEmailDeliveryAdapter } from "../src/server/services/smtp-email-delivery";
import { manualDiagnosticCodes, manualManagementPostconditionCodes } from "./p1-3-invitation.runtime-probe-contract";
import type { P13InvitationBrowserFixtures } from "./p1-3-invitation-browser-fixtures";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerRuntime = resolve(root, "..", "..", "..", "worker-runtime");
const composeFile = resolve(root, "scripts/p1-3-invitation.acceptance.compose.yml");
const normalRuntimeProbe = resolve(root, "scripts/p1-3-invitation.normal-runtime-probe.mjs");

const browserExecutables = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
] as const;

export type P13InvitationAcceptanceLifecycle = {
  prepare(): Promise<void>;
  migrate(): Promise<void>;
  verifyDatabase(): Promise<void>;
  verifySmtp(): Promise<void>;
  verifyInvitationRuntime(): Promise<void>;
  verifyBrowserCdp(): Promise<void>;
  cleanup(): Promise<void>;
};

type P13InvitationAcceptancePhase = "prepare" | "migrate" | "database" | "smtp" | "runtime" | "browser" | "cleanup";

const preparationDiagnosticCodes = new Set([
  "p1_3_invitation_acceptance_prisma_inventory_failed",
  "p1_3_invitation_acceptance_prisma_inventory_invalid",
  "p1_3_invitation_acceptance_postgres_start_failed",
  "p1_3_invitation_acceptance_port_probe_failed",
  "p1_3_invitation_acceptance_loopback_publication_invalid",
  "p1_3_invitation_acceptance_normal_runtime_probe_failed",
  "p1_3_invitation_acceptance_normal_runtime_mismatch",
  "p1_3_invitation_acceptance_global_role_provision_failed",
  "p1_3_invitation_acceptance_global_role_input_failed",
  "p1_3_invitation_acceptance_global_role_apply_failed",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_42501",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_42703",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_42704",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_42883",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_0a000",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_p0001",
  "p1_3_invitation_acceptance_global_role_apply_unreachable",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_22023",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_23502",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_23503",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_23505",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_55p03",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_40001",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_40p01",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_57014",
  "p1_3_invitation_acceptance_global_role_apply_sqlstate_53300",
  "p1_3_invitation_acceptance_invitation_role_provision_failed",
  "p1_3_invitation_acceptance_resource_probe_failed"
]);

const databaseDiagnosticCodes = new Set([
  "p1_3_invitation_acceptance_role_query_failed",
  "p1_3_invitation_acceptance_role_topology_invalid",
  "p1_3_invitation_acceptance_grant_query_failed",
  "p1_3_invitation_acceptance_runtime_grants_invalid",
  "p1_3_invitation_acceptance_private_audit_grant_query_failed",
  "p1_3_invitation_acceptance_private_audit_exposed",
  "p1_3_invitation_acceptance_direct_dml_not_denied",
  "p1_3_invitation_acceptance_key_read_not_denied",
  "p1_3_invitation_acceptance_key_lifecycle_query_failed",
  "p1_3_invitation_acceptance_key_lifecycle_invalid",
  "p1_3_invitation_acceptance_deferred_deletion_catalog_query_failed",
  "p1_3_invitation_acceptance_deferred_deletion_boundary_invalid",
  "p1_3_invitation_acceptance_manual_create_catalog_query_failed",
  "p1_3_invitation_acceptance_manual_create_catalog_identity_invalid",
  "p1_3_invitation_acceptance_permission_schema_usage_invalid",
  "p1_3_invitation_acceptance_permission_function_execute_invalid",
  "p1_3_invitation_acceptance_permission_relation_invalid",
  "p1_3_invitation_acceptance_permission_sequence_invalid",
  "p1_3_invitation_acceptance_permission_row_security_invalid",
  "p1_3_invitation_acceptance_permission_ownership_invalid",
  "p1_3_invitation_acceptance_permission_role_boundary_invalid",
  "p1_3_invitation_acceptance_permission_established_role_compatibility_invalid",
  "p1_3_invitation_acceptance_database_url_unavailable",
  "p1_3_invitation_acceptance_fresh_auth_key_provision_failed",
  "p1_3_invitation_acceptance_fresh_auth_overlap_failed",
  "p1_3_invitation_acceptance_delivery_key_provision_failed",
  "p1_3_invitation_acceptance_delivery_key_overlap_failed",
  "p1_3_invitation_acceptance_throttle_key_provision_failed",
  "p1_3_invitation_acceptance_smtp_certificate_failed",
  "p1_3_invitation_acceptance_smtp_loopback_failed",
  "p1_3_invitation_acceptance_tls_smtp_receipt_invalid"
]);

const runtimeDiagnosticCodes = new Set([
  ...manualDiagnosticCodes,
  ...manualManagementPostconditionCodes,
  "p1_3_invitation_acceptance_runtime_probe_failed",
  "p1_3_invitation_acceptance_runtime_persistence_invalid",
  "p1_3_invitation_acceptance_runtime_manual_management_failed",
  "p1_3_invitation_acceptance_runtime_service_bootstrap_failed",
  "p1_3_invitation_acceptance_runtime_probe_process_failed",
  "p1_3_invitation_acceptance_runtime_probe_output_invalid",
  "p1_3_invitation_acceptance_runtime_fixture_seed_failed",
  "p1_3_invitation_acceptance_runtime_manual_create_reserve_failed",
  "p1_3_invitation_acceptance_runtime_manual_create_submit_failed",
  "p1_3_invitation_acceptance_runtime_receipt_missing",
  "p1_3_invitation_acceptance_runtime_receipt_invalid",
  "p1_3_invitation_acceptance_runtime_receipt_not_safe",
  "p1_3_invitation_acceptance_fixture_database_unavailable",
  "p1_3_invitation_acceptance_created_invite_missing",
  "p1_3_invitation_acceptance_pending_invite_missing",
  "p1_3_invitation_acceptance_claim_invalid",
  "p1_3_invitation_acceptance_setup_corridor_not_neutral",
  "p1_3_invitation_acceptance_route_layer_invalid"
]);

const browserDiagnosticCodes = new Set([
  "p1_3_invitation_acceptance_browser_fixture_failed",
  "p1_3_invitation_acceptance_browser_fixture_credential_unverifiable",
  "p1_3_invitation_acceptance_browser_positive_control_absent",
  "p1_3_invitation_acceptance_browser_positive_control_unexpected",
  "p1_3_invitation_acceptance_browser_positive_control_unreadable",
  "p1_3_invitation_acceptance_browser_certificate_failed",
  "p1_3_invitation_acceptance_browser_tls_proxy_failed",
  "p1_3_invitation_acceptance_browser_app_dependencies_build_failed",
  "p1_3_invitation_acceptance_browser_app_builder_build_failed",
  "p1_3_invitation_acceptance_browser_app_runtime_dependencies_prune_failed",
  "p1_3_invitation_acceptance_browser_app_runner_public_failed",
  "p1_3_invitation_acceptance_browser_app_runner_standalone_failed",
  "p1_3_invitation_acceptance_browser_app_runner_static_failed",
  "p1_3_invitation_acceptance_browser_app_runner_runtime_artifacts_failed",
  "p1_3_invitation_acceptance_browser_app_runner_filesystem_failed",
  "p1_3_invitation_acceptance_browser_app_build_failed",
  "p1_3_invitation_acceptance_browser_app_runtime_image_build_failed",
  "p1_3_invitation_acceptance_browser_app_start_failed",
  "p1_3_invitation_acceptance_browser_app_port_failed",
  "p1_3_invitation_acceptance_browser_loopback_invalid",
  "p1_3_invitation_acceptance_browser_app_ready_failed",
  "p1_3_invitation_acceptance_browser_operation_infrastructure_invalid",
  "p1_3_invitation_acceptance_browser_app_health_unreachable",
  "p1_3_invitation_acceptance_browser_app_health_unavailable",
  "p1_3_invitation_acceptance_browser_app_health_verifier_scope_confirmed",
  "p1_3_invitation_acceptance_browser_route_sentinel_dispatch_failed",
  "p1_3_invitation_acceptance_browser_route_entry_and_response_confirmed",
  "p1_3_invitation_acceptance_browser_route_response_dispatch_failed",
  "p1_3_invitation_acceptance_browser_route_handler_not_entered",
  "p1_3_invitation_acceptance_browser_route_entry_marker_invalid",
  "p1_3_invitation_acceptance_browser_route_module_not_evaluated",
  "p1_3_invitation_acceptance_browser_route_marker_state_invalid",
  "p1_3_invitation_acceptance_browser_instrumentation_marker_invalid",
  "p1_3_invitation_acceptance_browser_instrumentation_not_entered",
  "p1_3_invitation_acceptance_browser_instrumentation_builtin_probe_failed",
  "p1_3_invitation_acceptance_browser_bootstrap_preload_not_entered",
  "p1_3_invitation_acceptance_browser_bootstrap_exec_not_selected",
  "p1_3_invitation_acceptance_browser_preload_file_not_loaded",
  "p1_3_invitation_acceptance_browser_preload_guards_not_confirmed",
  "p1_3_invitation_acceptance_browser_standalone_server_module_not_entered",
  "p1_3_invitation_acceptance_browser_next_package_not_loaded",
  "p1_3_invitation_acceptance_browser_start_server_module_not_loaded",
  "p1_3_invitation_acceptance_browser_start_server_not_invoked",
  "p1_3_invitation_acceptance_browser_next_server_module_not_loaded",
  "p1_3_invitation_acceptance_browser_instrumentation_module_not_requested",
  "p1_3_invitation_acceptance_browser_instrumentation_module_not_evaluated",
  "p1_3_invitation_acceptance_browser_instrumentation_register_not_entered",
  "p1_3_invitation_acceptance_browser_instrumentation_module_load_failed",
  "p1_3_invitation_acceptance_browser_instrumentation_automated_backup_start_failed",
  "p1_3_invitation_acceptance_browser_instrumentation_integrity_start_failed",
  "p1_3_invitation_acceptance_browser_instrumentation_sprout_retention_start_failed",
  "p1_3_invitation_acceptance_browser_instrumentation_browser_retention_start_failed",
  "p1_3_invitation_acceptance_browser_instrumentation_email_delivery_start_failed",
  "p1_3_invitation_acceptance_browser_instrumentation_email_change_start_failed",
  "p1_3_invitation_acceptance_browser_instrumentation_completed_route_failed",
  "p1_3_invitation_acceptance_browser_instrumentation_and_route_confirmed",
  "p1_3_invitation_acceptance_browser_framework_log_unavailable",
  "p1_3_invitation_acceptance_browser_framework_log_budget_exhausted",
  "p1_3_invitation_acceptance_browser_framework_module_resolution_failed",
  "p1_3_invitation_acceptance_browser_framework_reference_error",
  "p1_3_invitation_acceptance_browser_framework_type_error",
  "p1_3_invitation_acceptance_browser_framework_syntax_error",
  "p1_3_invitation_acceptance_browser_framework_invariant_error",
  "p1_3_invitation_acceptance_browser_framework_unclassified",

  "p1_3_invitation_acceptance_browser_app_health_route_error",
  "p1_3_invitation_acceptance_browser_tls_proxy_upstream_error",
  "p1_3_invitation_acceptance_browser_app_health_server_error",
  "p1_3_invitation_acceptance_browser_app_health_client_error",
  "p1_3_invitation_acceptance_browser_app_health_redirect",
  "p1_3_invitation_acceptance_browser_app_health_status_invalid",
  "p1_3_invitation_acceptance_browser_app_startup_status_missing",
  "p1_3_invitation_acceptance_browser_app_startup_status_invalid",
  "p1_3_invitation_acceptance_browser_app_readiness_guard_failed",
  "p1_3_invitation_acceptance_browser_app_configuration_failed",
  "p1_3_invitation_acceptance_browser_app_runtime_role_failed",
  "p1_3_invitation_acceptance_browser_app_invitation_runtime_roles_failed",
  "p1_3_invitation_acceptance_browser_app_migration_connection_failed",
  "p1_3_invitation_acceptance_browser_app_migration_apply_failed",
  "p1_3_invitation_acceptance_browser_app_fresh_auth_attestation_keys_failed",
  "p1_3_invitation_acceptance_browser_app_email_delivery_keys_failed",
  "p1_3_invitation_acceptance_browser_app_global_security_throttle_key_failed",
  "p1_3_invitation_acceptance_browser_app_readiness_guard_incomplete",
  "p1_3_invitation_acceptance_browser_app_migration_incomplete",
  "p1_3_invitation_acceptance_browser_missing",
  "p1_3_invitation_acceptance_browser_start_failed",
  "p1_3_invitation_acceptance_browser_debug_timeout",
  "p1_3_invitation_acceptance_browser_target_failed",
  "p1_3_invitation_acceptance_browser_cdp_connect_failed",
  "p1_3_invitation_acceptance_browser_cdp_failed",
  "p1_3_invitation_acceptance_browser_new_user_failed",
  "p1_3_invitation_acceptance_browser_new_user_claim_failed",
  "p1_3_invitation_acceptance_browser_new_user_credentials_failed",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_failed",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_open_failed",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_submit_failed",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_review_failed",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_submit_form_error",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_submit_form_error_client",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_submit_form_error_unauthorized",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_submit_form_error_forbidden",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_submit_form_error_server",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_submit_form_error_unavailable",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_submit_dispatch_pending",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_submit_neutral_landing",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_submit_navigation_failed",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_postcondition_probe_failed",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_session_absent",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_session_without_event",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_session_without_activity",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_session_with_activity",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_lookup",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_lookup_miss",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_unauthorized_user_not_found",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_unauthorized_credential_account_not_found",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_unauthorized_email_not_verified",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_unauthorized_failed_to_create_session",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_unauthorized_other",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_precheck",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_handler",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_failure_recording",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_parse",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_invalid_credentials_user_not_found",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_invalid_credentials_credential_account_not_found",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_invalid_credentials_password_not_found",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_invalid_credentials_password_mismatch",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_invalid_credentials_unclassified",
  "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_unreadable",
  "p1_3_invitation_acceptance_browser_new_user_acceptance_failed",
  "p1_3_invitation_acceptance_browser_new_user_acceptance_recovery_generate_failed",
  "p1_3_invitation_acceptance_browser_new_user_acceptance_recovery_copy_failed",
  "p1_3_invitation_acceptance_browser_new_user_acceptance_recovery_confirm_failed",
  "p1_3_invitation_acceptance_browser_new_user_acceptance_invitation_accept_failed",
  "p1_3_invitation_acceptance_browser_new_user_acceptance_post_accept_navigation_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_session_reset_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_claim_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_geometry_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_open_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_submit_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_review_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_submit_form_error_unauthorized",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_denial_credential_account_absent",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_denial_session_created",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_denial_throttle_quiet",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_denial_failure_recorded_only",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_denial_no_evidence",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_lookup",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_lookup_miss",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_unauthorized_user_not_found",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_unauthorized_credential_account_not_found",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_unauthorized_email_not_verified",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_unauthorized_failed_to_create_session",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_unauthorized_other",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_precheck",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_handler",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_failure_recording",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_parse",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_invalid_credentials_user_not_found",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_invalid_credentials_credential_account_not_found",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_invalid_credentials_password_not_found",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_invalid_credentials_password_mismatch",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_invalid_credentials_unclassified",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_denial_probe_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_unreadable",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_submit_form_error_forbidden",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_submit_form_error_client",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_submit_form_error_server",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_submit_form_error_unavailable",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_submit_dispatch_pending",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_submit_neutral_landing",
  "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_submit_navigation_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_acceptance_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_acceptance_recovery_generate_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_acceptance_recovery_copy_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_acceptance_recovery_confirm_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_acceptance_invitation_accept_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_acceptance_post_accept_navigation_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_fingerprint_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_reserve_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_recovery_render_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_unobserved_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_observer_unavailable_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_recovery_enrollment_reserve_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_recovery_enrollment_submit_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_recovery_recovery_render_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_recovery_enrollment_unobserved_failed",
  "p1_3_invitation_acceptance_browser_existing_recipient_recovery_enrollment_observer_unavailable_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_network_absent_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_reserve_post_no_response_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_reserve_other_method_no_response_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_post_no_response_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_other_method_no_response_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_reserve_response_1xx_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_reserve_response_2xx_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_reserve_response_3xx_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_reserve_response_4xx_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_reserve_response_5xx_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_reserve_response_invalid_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_response_1xx_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_response_2xx_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_response_3xx_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_response_4xx_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_response_5xx_failed",
  "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_response_invalid_failed",
  "p1_3_invitation_acceptance_browser_existing_user_failed",
  "p1_3_invitation_acceptance_browser_response_loss_invalid",
  "p1_3_invitation_acceptance_browser_response_loss_not_intercepted",
  "p1_3_invitation_acceptance_browser_response_loss_interceptor_failed",
  "p1_3_invitation_acceptance_browser_response_loss_retained_not_written",
  "p1_3_invitation_acceptance_browser_response_loss_surface_not_restored",
  "p1_3_invitation_acceptance_browser_response_loss_retained_operation_not_rendered",
  "p1_3_invitation_acceptance_browser_response_loss_status_not_recovered",
  "p1_3_invitation_acceptance_browser_privacy_invalid",
  "p1_3_invitation_acceptance_browser_geometry_invalid",
  "p1_3_invitation_acceptance_browser_cleanup_failed"
]);

function isDatabaseDiagnosticError(error: unknown): error is Error {
  return error instanceof Error && databaseDiagnosticCodes.has(error.message);
}

function isPreparationDiagnosticError(error: unknown): error is Error {
  return error instanceof Error && preparationDiagnosticCodes.has(error.message);
}

function isRuntimeDiagnosticError(error: unknown): error is Error {
  return error instanceof Error && runtimeDiagnosticCodes.has(error.message);
}

function isBrowserDiagnosticError(error: unknown): error is Error {
  return error instanceof Error && (
    browserDiagnosticCodes.has(error.message)
    || /^p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_schema_(?:1xx|2xx|3xx|4xx|5xx|invalid)_(?:true|false|absent)_(?:present|absent)_(?:generated|completed|unavailable|other|absent)_(?:exactly_10|other|absent)_(?:valid|invalid)_failed$/.test(error.message)
    || /^p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_origin_(?:setup_session_absent|setup_corridor_rejected|submit_service_error|submit_empty_receipt|submit_terminal_unavailable|submit_terminal_generated|submit_terminal_completed|submit_state_fresh_auth_bound|submit_state_prepared|submit_state_other|submit_receipt_invalid|submit_server_legacy_invalid|submit_header_unsupported|observer_absent)_failed$/.test(error.message)
  );
}

export function p13InvitationAcceptanceFailureCode(error: unknown) {
  if (isPreparationDiagnosticError(error)) return error.message;
  if (isDatabaseDiagnosticError(error)) return error.message;
  if (isRuntimeDiagnosticError(error)) return error.message;
  if (isBrowserDiagnosticError(error)) return error.message;
  if (
    error instanceof Error
    && /^p1_3_invitation_acceptance_(prepare|migrate|database|smtp|runtime|browser|cleanup|unknown)_failed$/.test(error.message)
  ) return error.message;
  return "p1_3_invitation_acceptance_failed";
}

export async function executeP13InvitationAcceptance(
  lifecycle: P13InvitationAcceptanceLifecycle,
  emit: (event: "p1_3_invitation_acceptance_complete") => void = () => undefined
) {
  let phase: P13InvitationAcceptancePhase = "prepare";
  let failure: unknown;
  let failurePhase: P13InvitationAcceptancePhase | undefined;
  try {
    await lifecycle.prepare();
    phase = "migrate";
    await lifecycle.migrate();
    phase = "database";
    await lifecycle.verifyDatabase();
    phase = "smtp";
    await lifecycle.verifySmtp();
    phase = "runtime";
    await lifecycle.verifyInvitationRuntime();
    phase = "browser";
    await lifecycle.verifyBrowserCdp();
  } catch (error) {
    failure = error;
    failurePhase = phase;
  }

  try {
    phase = "cleanup";
    await lifecycle.cleanup();
  } catch {
    failure = new Error("p1_3_invitation_acceptance_cleanup_failed");
    failurePhase = phase;
  }

  if (failure) {
    if (failurePhase === "prepare" && isPreparationDiagnosticError(failure)) throw failure;
    if (failurePhase === "database" && isDatabaseDiagnosticError(failure)) throw failure;
    if (failurePhase === "runtime" && isRuntimeDiagnosticError(failure)) throw failure;
    if (failurePhase === "browser" && isBrowserDiagnosticError(failure)) throw failure;
    throw new Error(`p1_3_invitation_acceptance_${failurePhase ?? "unknown"}_failed`);
  }
  emit("p1_3_invitation_acceptance_complete");
}

type RunContext = {
  project: string;
  env: NodeJS.ProcessEnv;
  temporaryRoot: string;
  startupStatusRoot: string;
  copiedPrisma: string;
  migratorPassword: string;
  rolePasswords: Readonly<Record<string, string>>;
  freshAuthKeys: readonly [string, string];
  deliveryKeys: readonly [string, string];
  throttleKey: string;
  disposableImageTags: string[];
  databaseUrl?: string;
};

function hostExecutableEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PATH: process.env.PATH,
    Path: process.env.Path,
    PATHEXT: process.env.PATHEXT,
    SYSTEMROOT: process.env.SYSTEMROOT,
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    APPDATA: process.env.APPDATA,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    PROGRAMDATA: process.env.PROGRAMDATA,
    ProgramFiles: process.env.ProgramFiles,
    ProgramW6432: process.env.ProgramW6432,
    "ProgramFiles(x86)": process.env["ProgramFiles(x86)"]
  } as NodeJS.ProcessEnv;
}

function safeEnvironment(user: string, database: string, password: string): NodeJS.ProcessEnv {
  const environment = hostExecutableEnvironment();
  Object.assign(environment, {
    COMPOSE_DISABLE_ENV_FILE: "true",
    NODE_ENV: "test",
    CUBBY_BROWSER_OPERATION_ACCEPTANCE_USER: user,
    CUBBY_BROWSER_OPERATION_ACCEPTANCE_DATABASE: database,
    CUBBY_BROWSER_OPERATION_ACCEPTANCE_PASSWORD: password,
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "1",
    SMTP_USER: `${user}_smtp`,
    SMTP_PASSWORD: password,
    EMAIL_FROM: "Cubby <noreply@acceptance.invalid>",
    SMTP_SECURE: "false"
  });
  return environment;
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv, code: string, cwd = root): string {
  // Only pre-existing fixed observation commands may capture stdout. Writer
  // commands (including builds) have no output pipe at all; stderr is discarded.
  const observations: Readonly<Record<string, RegExp>> = {
    p1_3_invitation_acceptance_port_probe_failed: /^127\.0\.0\.1:\d+$/,
    p1_3_invitation_acceptance_browser_app_port_failed: /^127\.0\.0\.1:\d+$/,
    p1_3_invitation_acceptance_resource_probe_failed: /^(?:[a-zA-Z0-9_.:-]+(?:\r?\n|$))*$/,
    p1_3_invitation_acceptance_manual_create_catalog_query_failed: /^[01]$/,
    p1_3_invitation_acceptance_role_query_failed: /^\d+$/,
    p1_3_invitation_acceptance_grant_query_failed: /^\d+\|\d+$/,
    p1_3_invitation_acceptance_private_audit_grant_query_failed: /^\d+$/,
    p1_3_invitation_acceptance_key_lifecycle_query_failed: /^\d+\|\d+$/,
    p1_3_invitation_acceptance_deferred_deletion_catalog_query_failed: /^\d+\|\d+\|\d+\|\d+\|\d+\|(?:true|false)\|(?:true|false)\|(?:true|false)$/,
    p1_3_invitation_acceptance_browser_new_user_sign_in_postcondition_probe_failed: /^(?:session_absent|session_without_event|session_without_activity|session_with_activity)$/,
    p1_3_invitation_acceptance_browser_existing_recipient_sign_in_denial_probe_failed: /^(?:credential_account_absent|session_created|throttle_quiet|failure_recorded_only|no_evidence)$/
  };
  const fixed = command === "docker" ? observations[code]
    ?? (/^p1_3_invitation_acceptance_permission_(?:schema_usage|function_execute|relation|sequence|row_security|ownership|role_boundary|established_role_compatibility)_invalid$/.test(code) ? /^[01]$/ : undefined)
    : command === "node" && code === "p1_3_invitation_acceptance_normal_runtime_probe_failed"
      ? /^p1_3_invitation_acceptance_normal_runtime_match$/
      : undefined;
  const fixedFailure = command === "node" && code === "p1_3_invitation_acceptance_global_role_provision_failed"
    ? /^p1_3_invitation_acceptance_global_role_(?:input_failed|apply_(?:failed|unreachable|sqlstate_(?:42501|42703|42704|42883|0a000|p0001|22023|23502|23503|23505|55p03|40001|40p01|57014|53300)))$/
    : command === "node" && code === "p1_3_invitation_acceptance_normal_runtime_probe_failed"
      ? /^p1_3_invitation_acceptance_normal_runtime_mismatch$/
      : undefined;
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", fixed || fixedFailure ? "pipe" : "ignore", "ignore"], maxBuffer: 16_384, timeout: 600_000 });
  if (result.error || result.status !== 0) {
    const output = fixedFailure ? (result.stdout ?? "").trim() : "";
    if (fixedFailure?.test(output)) throw new Error(output);
    throw new Error(code);
  }
  if (!fixed) return "";
  const output = (result.stdout ?? "").trim();
  if (!fixed.test(output)) throw new Error(code);
  return output;
}

export function p13InvitationRuntimeProbeCommand(base = root) {
  return {
    executable: process.execPath,
    args: ["--import", "tsx", resolve(base, "scripts/p1-3-invitation.runtime-probe.ts")]
  };
}

async function runRuntimeProbe(context: RunContext) {
  const command = p13InvitationRuntimeProbeCommand();
  await new Promise<void>((resolveProbe, rejectProbe) => {
    const child = spawn(command.executable, command.args, {
      cwd: root, env: context.env, stdio: ["ignore", "ignore", "ignore", "ipc"], timeout: 600_000
    });
    let code: string | undefined;
    let invalid = false;
    child.on("message", (message) => {
      if (code || typeof message !== "string" || !runtimeDiagnosticCodes.has(message)) invalid = true;
      else code = message;
    });
    child.once("error", () => rejectProbe(new Error("p1_3_invitation_acceptance_runtime_probe_process_failed")));
    child.once("exit", (status) => {
      if (invalid || (status === 0 && code)) rejectProbe(new Error("p1_3_invitation_acceptance_runtime_probe_output_invalid"));
      else if (status === 0) resolveProbe();
      else rejectProbe(new Error(code ?? "p1_3_invitation_acceptance_runtime_probe_process_failed"));
    });
  });
}

export function p13InvitationRuntimeProbeOutputCode(output: string) {
  return [...runtimeDiagnosticCodes].find((candidate) => output.split(/\r?\n/).includes(candidate))
    ?? "p1_3_invitation_acceptance_runtime_probe_output_invalid";
}

function expectRejected(command: string, args: readonly string[], env: NodeJS.ProcessEnv, code: string, expectedDiagnostic: string) {
  const statement = args.at(-1);
  const statements: Readonly<Record<string, string>> = {
    p1_3_invitation_acceptance_direct_dml_not_denied: `INSERT INTO invitation_protocol."InvitationOperationIdentity" ("id") VALUES ('00000000-0000-4000-8000-000000000001');`,
    p1_3_invitation_acceptance_key_read_not_denied: `SELECT * FROM public."FreshAuthAttestationKey";`
  };
  if (command !== "docker" || args.at(-2) !== "-c" || expectedDiagnostic !== "permission denied" || !statement || statements[code] !== statement) throw new Error(code);
  // Unexpected success is rolled back; only the already-tested 42501 denial
  // permits a zero exit. No query result or PostgreSQL error is captured.
  const assertion = `DO $p13$ BEGIN BEGIN EXECUTE '${statement.replaceAll("'", "''")}'; RAISE EXCEPTION USING ERRCODE = 'P0001'; EXCEPTION WHEN insufficient_privilege THEN RETURN; END; END $p13$;`;
  const result = spawnSync(command, [...args.slice(0, -1), assertion], { cwd: root, env, stdio: ["ignore", "ignore", "ignore"], timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(code);
}

function copyCurrentPrisma(destination: string) {
  const source = resolve(root, "prisma");
  const sourceMigrations = resolve(source, "migrations");
  if (!existsSync(resolve(source, "schema.prisma")) || !existsSync(resolve(sourceMigrations, "migration_lock.toml"))) {
    throw new Error("p1_3_invitation_acceptance_prisma_inventory_invalid");
  }
  const ignoredEmptyMigrationDirectory = "20260904100000_invitation_protocol_v6";
  const migrationDirectories: string[] = [];
  for (const entry of readdirSync(resolve(root, "prisma", "migrations"), { withFileTypes: true })) {
    if (entry.name === "migration_lock.toml" && entry.isFile()) continue;
    if (!entry.isDirectory() || !/^\d{14}_[a-z0-9_]+$/.test(entry.name)) {
      throw new Error("p1_3_invitation_acceptance_prisma_inventory_invalid");
    }
    const sourceDirectory = resolve(sourceMigrations, entry.name);
    const files = readdirSync(sourceDirectory, { withFileTypes: true });
    if (entry.name === ignoredEmptyMigrationDirectory && files.length === 0) continue;
    if (files.length !== 1 || !files[0]?.isFile() || files[0].name !== "migration.sql") {
      throw new Error("p1_3_invitation_acceptance_prisma_inventory_invalid");
    }
    migrationDirectories.push(entry.name);
  }
  migrationDirectories.sort();
  if (migrationDirectories.length === 0) throw new Error("p1_3_invitation_acceptance_prisma_inventory_invalid");

  mkdirSync(resolve(destination, "migrations"), { recursive: true });
  copyFileSync(resolve(source, "schema.prisma"), resolve(destination, "schema.prisma"));
  copyFileSync(resolve(sourceMigrations, "migration_lock.toml"), resolve(destination, "migrations", "migration_lock.toml"));
  for (const migrationDirectory of migrationDirectories) {
    const sourceDirectory = resolve(sourceMigrations, migrationDirectory);
    const targetDirectory = resolve(destination, "migrations", migrationDirectory);
    mkdirSync(targetDirectory, { recursive: true });
    copyFileSync(resolve(sourceDirectory, "migration.sql"), resolve(targetDirectory, "migration.sql"));
  }
}

function postgresUrl(user: string, password: string, published: string, database: string) {
  const url = new URL(`postgresql://${encodeURIComponent(user)}@${published}/${database}`);
  url.password = password;
  url.searchParams.set("schema", "public");
  return url.toString();
}

function roleUrl(databaseUrl: string, role: string, password: string) {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

function psqlArguments(context: RunContext, statement: string, role = "migrator") {
  const password = role === "migrator" ? context.migratorPassword : context.rolePasswords[role];
  const user = role === "migrator" ? context.env.CUBBY_BROWSER_OPERATION_ACCEPTANCE_USER! : role;
  return [
    "compose", "--project-name", context.project, "--file", composeFile,
    "exec", "-T", "postgres", "env", `PGPASSWORD=${password}`,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-U", user,
    "-d", context.env.CUBBY_BROWSER_OPERATION_ACCEPTANCE_DATABASE!, "-c", statement
  ];
}

async function startAuthenticatedTlsSmtp(input: { key: Buffer; cert: Buffer; username: string; password: string; recipient: string }) {
  let authenticated = false;
  const accepted: string[] = [];
  const server = createTlsServer({ key: input.key, cert: input.cert }, (socket) => {
    socket.setEncoding("utf8");
    socket.write("220 acceptance.invalid ESMTP\r\n");
    let buffered = "";
    let dataMode = false;
    socket.on("data", (chunk) => {
      buffered += chunk;
      if (dataMode) {
        const end = buffered.indexOf("\r\n.\r\n");
        if (end < 0) return;
        buffered = buffered.slice(end + 5);
        dataMode = false;
        socket.write("250 2.0.0 accepted\r\n");
      }
      while (!dataMode) {
        const end = buffered.indexOf("\r\n");
        if (end < 0) return;
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (/^(EHLO|HELO)\b/i.test(line)) socket.write("250-acceptance.invalid\r\n250-AUTH PLAIN\r\n250 SIZE 1048576\r\n");
        else if (/^AUTH PLAIN\s+/i.test(line)) {
          const parts = Buffer.from(line.replace(/^AUTH PLAIN\s+/i, ""), "base64").toString("utf8").split("\0");
          authenticated = parts.at(-2) === input.username && parts.at(-1) === input.password;
          socket.write(authenticated ? "235 2.7.0 authenticated\r\n" : "535 5.7.8 rejected\r\n");
        } else if (/^MAIL FROM:/i.test(line)) socket.write(authenticated ? "250 2.1.0 sender ok\r\n" : "530 5.7.0 authentication required\r\n");
        else if (/^RCPT TO:/i.test(line)) {
          const acceptedRecipient = authenticated && line.toLowerCase().includes(input.recipient.toLowerCase());
          if (acceptedRecipient) accepted.push(input.recipient);
          socket.write(acceptedRecipient ? "250 2.1.5 recipient ok\r\n" : "550 5.1.1 rejected\r\n");
        } else if (/^DATA$/i.test(line)) {
          dataMode = true;
          socket.write("354 end with <CRLF>.<CRLF>\r\n");
        } else if (/^QUIT$/i.test(line)) {
          socket.end("221 2.0.0 bye\r\n");
          return;
        } else socket.write("250 2.0.0 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("p1_3_invitation_acceptance_smtp_loopback_failed");
  return {
    port: address.port,
    get authenticated() { return authenticated; },
    accepted,
    close: () => new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
  };
}

export function p13InvitationResourceArguments(project: string, kind: "ps" | "volume" | "network" | "image") {
  return [kind, kind === "ps" ? "--all" : "ls", "--quiet", "--filter", `label=com.docker.compose.project=${project}`];
}

export type P13InvitationDisposablePreflight = {
  temporaryRootPresent: boolean;
  containersPresent: boolean;
  volumesPresent: boolean;
  networksPresent: boolean;
  imagesPresent: boolean;
};

export function p13InvitationDisposablePreflightFailureCode(observed: P13InvitationDisposablePreflight) {
  return Object.values(observed).some(Boolean)
    ? "p1_3_invitation_acceptance_disposable_preflight_failed"
    : undefined;
}

export function p13InvitationManualCreateCatalogStatement() {
  return `SELECT CASE WHEN to_regprocedure('invitation_protocol.reserve_manual_invite_create_v2(uuid,text,public."HouseholdRole",integer,text,bytea,invitation_protocol.invitation_request_attestation)') IS NULL THEN '0' ELSE '1' END;`;
}

export function p13InvitationPermissionCatalogChecks() {
  const targetRelations = `ARRAY['Invite','HouseholdMember','User','Account','AccountSecurityState','RecoveryCodeSet','RecoveryCode','AuditEvent','FreshAuthAttestationKey','Household','Session','FreshAuthGrant','GlobalSecurityOperation','GlobalSecurityOperationBinding']`;
  return [
    {
      category: "schema_usage",
      statement: "SELECT CASE WHEN has_schema_privilege('invitation_protocol_owner_nologin','public','USAGE') AND has_schema_privilege('cubby_invitation_runtime','invitation_protocol','USAGE') THEN '1' ELSE '0' END;",
    },
    {
      category: "function_execute",
      statement: `SELECT CASE WHEN has_function_privilege('invitation_protocol_owner_nologin','public.gen_random_bytes(integer)','EXECUTE') AND has_function_privilege('invitation_protocol_owner_nologin','public.digest(bytea,text)','EXECUTE') AND has_function_privilege('invitation_protocol_owner_nologin','public.hmac(bytea,bytea,text)','EXECUTE') AND has_function_privilege('cubby_invitation_runtime','invitation_protocol.reserve_manual_invite_create_v2(uuid,text,public."HouseholdRole",integer,text,bytea,invitation_protocol.invitation_request_attestation)','EXECUTE') THEN '1' ELSE '0' END;`,
    },
    {
      category: "relation",
      statement: `SELECT CASE WHEN has_table_privilege('invitation_protocol_owner_nologin','public."Invite"','SELECT,INSERT,UPDATE,DELETE') AND has_table_privilege('invitation_protocol_owner_nologin','public."HouseholdMember"','SELECT,INSERT,UPDATE,DELETE') AND has_table_privilege('invitation_protocol_owner_nologin','public."User"','SELECT,INSERT,UPDATE,DELETE') AND has_table_privilege('invitation_protocol_owner_nologin','public."Account"','SELECT,INSERT,UPDATE,DELETE') AND has_table_privilege('invitation_protocol_owner_nologin','public."AccountSecurityState"','SELECT,INSERT,UPDATE,DELETE') AND has_table_privilege('invitation_protocol_owner_nologin','public."RecoveryCodeSet"','SELECT,INSERT,UPDATE,DELETE') AND has_table_privilege('invitation_protocol_owner_nologin','public."RecoveryCode"','SELECT,INSERT,UPDATE,DELETE') AND has_table_privilege('invitation_protocol_owner_nologin','public."AuditEvent"','SELECT,INSERT,UPDATE,DELETE') AND has_table_privilege('invitation_protocol_owner_nologin','public."FreshAuthAttestationKey"','SELECT,UPDATE') AND has_table_privilege('invitation_protocol_owner_nologin','public."Household"','SELECT,UPDATE') AND has_table_privilege('invitation_protocol_owner_nologin','public."Session"','SELECT,UPDATE') AND has_table_privilege('invitation_protocol_owner_nologin','public."FreshAuthGrant"','INSERT') AND has_table_privilege('invitation_protocol_owner_nologin','public."GlobalSecurityOperation"','INSERT') AND has_table_privilege('invitation_protocol_owner_nologin','public."GlobalSecurityOperationBinding"','INSERT') THEN '1' ELSE '0' END;`,
    },
    {
      category: "sequence",
      statement: `SELECT CASE WHEN count(*)=0 THEN '1' ELSE '0' END FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(${targetRelations}) AND pg_get_expr(d.adbin,d.adrelid) LIKE '%nextval%';`,
    },
    {
      category: "row_security",
      statement: `SELECT CASE WHEN count(*) FILTER (WHERE c.relrowsecurity OR c.relforcerowsecurity)=0 THEN '1' ELSE '0' END FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY(${targetRelations});`,
    },
    {
      category: "ownership",
      statement: "SELECT CASE WHEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='invitation_protocol' AND pg_get_userbyid(p.proowner)<>'invitation_protocol_owner_nologin')=0 AND (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='invitation_protocol' AND c.relkind IN ('r','S') AND pg_get_userbyid(c.relowner)<>'invitation_protocol_owner_nologin')=0 THEN '1' ELSE '0' END;",
    },
    {
      category: "role_boundary",
      statement: "SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname='invitation_protocol_owner_nologin' AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls) AND NOT pg_has_role('cubby_invitation_runtime','invitation_protocol_owner_nologin','USAGE') THEN '1' ELSE '0' END;",
    },
    {
      category: "established_role_compatibility",
      statement: "SELECT CASE WHEN has_table_privilege('cubby_runtime','public.\"User\"','SELECT') AND has_table_privilege('cubby_auth','public.\"User\"','SELECT') AND has_table_privilege('cubby_auth','public.\"Account\"','SELECT') AND has_table_privilege('cubby_auth','public.\"Verification\"','SELECT') AND has_table_privilege('cubby_auth','public.\"Session\"','SELECT') AND has_table_privilege('cubby_auth','public.\"Session\"','INSERT,UPDATE,DELETE') AND NOT has_table_privilege('cubby_auth','public.\"Account\"','INSERT,UPDATE,DELETE') THEN '1' ELSE '0' END;",
    },
  ].map((check) => ({
    ...check,
    expected: "1",
    failureCode: `p1_3_invitation_acceptance_permission_${check.category}_invalid`,
  }));
}

function resourceCount(context: RunContext, kind: "ps" | "volume" | "network" | "image") {
  return run("docker", p13InvitationResourceArguments(context.project, kind), context.env, "p1_3_invitation_acceptance_resource_probe_failed");
}

function assertP13InvitationDisposablePreflight(context: RunContext) {
  const failure = p13InvitationDisposablePreflightFailureCode({
    temporaryRootPresent: existsSync(context.temporaryRoot),
    containersPresent: Boolean(resourceCount(context, "ps")),
    volumesPresent: Boolean(resourceCount(context, "volume")),
    networksPresent: Boolean(resourceCount(context, "network")),
    imagesPresent: Boolean(resourceCount(context, "image"))
  });
  if (failure) throw new Error(failure);
}

function verifyP13InvitationNormalRuntime() {
  const result = run("node", [normalRuntimeProbe], hostExecutableEnvironment(), "p1_3_invitation_acceptance_normal_runtime_probe_failed");
  if (result !== "p1_3_invitation_acceptance_normal_runtime_match") {
    throw new Error("p1_3_invitation_acceptance_normal_runtime_probe_failed");
  }
}

function buildP13InvitationAppStage(context: RunContext, target: "deps" | "builder" | "runner-dependencies" | "runner-public" | "runner-standalone" | "runner-static" | "runner-runtime-artifacts" | "runner-filesystem", code: string) {
  const tag = `${context.project}-${target}`;
  context.disposableImageTags.push(tag);
  run("docker", ["build", "--build-arg", `NEXT_PUBLIC_CUBBY_P13_RECOVERY_SCHEMA_OBSERVER=${context.env.NEXT_PUBLIC_CUBBY_P13_RECOVERY_SCHEMA_OBSERVER ?? ""}`, "--build-arg", `CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER=${context.env.CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER ?? ""}`, "--label", `com.docker.compose.project=${context.project}`, "--tag", tag, "--target", target, root], context.env, code);
}

function buildP13InvitationAppImage(context: RunContext) {
  const tag = context.env.CUBBY_P13_INVITATION_APP_IMAGE;
  if (!tag) throw new Error("p1_3_invitation_acceptance_browser_app_runner_filesystem_failed");
  context.disposableImageTags.push(tag);
  run("docker", ["build", "--build-arg", `NEXT_PUBLIC_CUBBY_P13_RECOVERY_SCHEMA_OBSERVER=${context.env.NEXT_PUBLIC_CUBBY_P13_RECOVERY_SCHEMA_OBSERVER ?? ""}`, "--build-arg", `CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER=${context.env.CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER ?? ""}`, "--label", `com.docker.compose.project=${context.project}`, "--tag", tag, root], context.env, "p1_3_invitation_acceptance_browser_app_runner_filesystem_failed");
}

type CdpMessage = {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: { targetId?: string; sessionId?: string; result?: { value?: unknown }; exceptionDetails?: unknown; entries?: Array<{ url?: string }> };
  error?: { message?: string };
};

type CdpClient = {
  call(method: string, params?: Record<string, unknown>): Promise<CdpMessage>;
  on(method: string, handler: (params: Record<string, unknown>) => void): () => void;
  close(): void;
};

type InvitationRecipient = P13InvitationBrowserFixtures["newUser"];

async function waitForP13Browser(predicate: () => Promise<boolean>, code: string, attempts = 240, delay = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (await predicate()) return;
    } catch {
      // Replaced page execution contexts and startup races are transient only inside this bounded wait.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, delay));
  }
  throw new Error(code);
}

async function connectP13InvitationCdp(browser: ChildProcess): Promise<CdpClient> {
  const input = browser.stdio[3] as Writable | null;
  const output = browser.stdio[4] as Readable | null;
  if (!input || !output) throw new Error("p1_3_invitation_acceptance_browser_cdp_connect_failed");
  let nextId = 1;
  let pageSession: string | undefined;
  let closed = false;
  let buffer = Buffer.alloc(0);
  const pending = new Map<number, { resolve: (message: CdpMessage) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  const handlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  const receive = (message: CdpMessage) => {
    if (!message.id) {
      if (message.sessionId === pageSession && message.method) for (const handler of handlers.get(message.method) ?? []) handler(message.params ?? {});
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timeout);
    if (message.error) request.reject(new Error("p1_3_invitation_acceptance_browser_cdp_failed"));
    else request.resolve(message);
  };
  const client: CdpClient = {
    call(method, params = {}) {
      if (closed) return Promise.reject(new Error("p1_3_invitation_acceptance_browser_cdp_failed"));
      const id = nextId++;
      return new Promise<CdpMessage>((resolveCall, rejectCall) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectCall(new Error("p1_3_invitation_acceptance_browser_cdp_failed"));
        }, 20_000);
        pending.set(id, { resolve: resolveCall, reject: rejectCall, timeout });
        try { input.write(`${JSON.stringify({ id, method, params, sessionId: pageSession })}\0`); } catch {
          clearTimeout(timeout);
          pending.delete(id);
          rejectCall(new Error("p1_3_invitation_acceptance_browser_cdp_failed"));
        }
      });
    },
    on(method, handler) {
      const set = handlers.get(method) ?? new Set();
      set.add(handler);
      handlers.set(method, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) handlers.delete(method);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new Error("p1_3_invitation_acceptance_browser_cdp_failed"));
      }
      pending.clear();
      buffer = Buffer.alloc(0);
      handlers.clear();
      input.destroy();
      output.destroy();
    }
  };
  output.on("data", (chunk: Buffer) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 1_048_576) { client.close(); return; }
    let separator: number;
    while ((separator = buffer.indexOf(0)) !== -1) {
      const frame = buffer.subarray(0, separator);
      buffer = buffer.subarray(separator + 1);
      try { receive(JSON.parse(frame.toString("utf8")) as CdpMessage); } catch { client.close(); return; }
    }
  });
  input.on("error", () => client.close());
  output.on("error", () => client.close());
  output.on("end", () => client.close());
  browser.once("error", () => client.close());
  browser.once("exit", () => client.close());
  try {
    const target = await client.call("Target.createTarget", { url: "about:blank" });
    if (!target.result?.targetId) throw new Error("p1_3_invitation_acceptance_browser_target_failed");
    const attached = await client.call("Target.attachToTarget", { targetId: target.result.targetId, flatten: true });
    if (!attached.result?.sessionId) throw new Error("p1_3_invitation_acceptance_browser_target_failed");
    pageSession = attached.result.sessionId;
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

async function cdpValue<T>(client: CdpClient, expression: string, code = "p1_3_invitation_acceptance_browser_cdp_failed") {
  const response = await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.error || response.result?.exceptionDetails) throw new Error(code);
  return response.result?.result?.value as T;
}

async function assertP13Browser(client: CdpClient, expression: string, code: string) {
  await waitForP13Browser(async () => await cdpValue<boolean>(client, `Boolean(${expression})`) === true, code);
}

async function setP13BrowserViewport(client: CdpClient, width: number, height: number, mobile: boolean) {
  await client.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile, screenWidth: width, screenHeight: height });
  await assertP13Browser(client, `!document.querySelector('meta[name="viewport"]') || (innerWidth === ${width} && innerHeight === ${height})`, "p1_3_invitation_acceptance_browser_geometry_invalid");
}

async function focusP13BrowserSelector(client: CdpClient, selector: string, code: string) {
  const selected = await cdpValue<boolean>(client, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!(node instanceof HTMLElement)) return false; node.focus(); return document.activeElement === node; })()`);
  if (!selected) throw new Error(code);
}

async function setP13BrowserInput(client: CdpClient, selector: string, text: string) {
  await focusP13BrowserSelector(client, selector, "p1_3_invitation_acceptance_browser_geometry_invalid");
  const changed = await cdpValue<boolean>(client, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; if (!(node instanceof HTMLInputElement) || !set) return false; set.call(node, ${JSON.stringify(text)}); node.dispatchEvent(new Event("input", { bubbles: true })); node.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  if (!changed) throw new Error("p1_3_invitation_acceptance_browser_geometry_invalid");
}

async function keyboardActivateP13BrowserText(client: CdpClient, text: string) {
  const focused = await cdpValue<boolean>(client, `(() => { const node = Array.from(document.querySelectorAll("button,a")).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)}); if (!(node instanceof HTMLElement)) return false; node.focus(); return document.activeElement === node; })()`);
  if (!focused) throw new Error("p1_3_invitation_acceptance_browser_geometry_invalid");
  await client.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await client.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

async function touchActivateP13BrowserSelector(client: CdpClient, selector: string) {
  const point = await cdpValue<{ x?: number; y?: number } | null>(client, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!(node instanceof HTMLElement)) return null; node.scrollIntoView({ block: "center", inline: "center" }); const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null; })()`);
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") throw new Error("p1_3_invitation_acceptance_browser_geometry_invalid");
  await client.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, radiusX: 1, radiusY: 1, force: 1 }] });
  await client.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function touchActivateP13BrowserText(client: CdpClient, text: string) {
  const point = await cdpValue<{ x?: number; y?: number } | null>(client, `(() => { const node = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)}); if (!(node instanceof HTMLElement)) return null; node.scrollIntoView({ block: "center", inline: "center" }); const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null; })()`);
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") throw new Error("p1_3_invitation_acceptance_browser_geometry_invalid");
  await client.call("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, radiusX: 1, radiusY: 1, force: 1 }] });
  await client.call("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function assertP13InvitationGeometry(client: CdpClient) {
  const valid = await cdpValue<boolean>(client, `(() => {
    const controls = Array.from(document.querySelectorAll("button,input,a")).filter((node) => node instanceof HTMLElement && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
    return document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth
      && controls.every((node) => {
        const rect = node.getBoundingClientRect();
        const name = node.getAttribute("aria-label") || (node instanceof HTMLInputElement ? node.labels?.[0]?.textContent : null) || node.textContent;
        return rect.width >= 44 && rect.height >= 44 && Boolean(name?.trim());
      });
  })()`);
  if (!valid) throw new Error("p1_3_invitation_acceptance_browser_geometry_invalid");
}

async function assertP13InvitationTokenPrivacy(client: CdpClient, token: string) {
  const surfaceSafe = await cdpValue<boolean>(client, `(() => {
    const token = ${JSON.stringify(token)};
    const values = [location.href, document.documentElement.outerHTML, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), JSON.stringify(history.state)];
    return values.every((value) => !value.includes(token));
  })()`);
  const navigation = await client.call("Page.getNavigationHistory");
  const historyEntries = navigation.result?.entries;
  if (!surfaceSafe || !Array.isArray(historyEntries) || historyEntries.some((entry) => typeof entry.url !== "string" || entry.url.includes(token))) {
    throw new Error("p1_3_invitation_acceptance_browser_privacy_invalid");
  }
}

async function waitForP13InvitationSurface(client: CdpClient, code: string) {
  await waitForP13Browser(async () => await cdpValue<boolean>(client, "document.readyState === 'complete' && (document.body.innerText.includes('Continue your invitation') || document.body.innerText.includes('Review your invitation'))") === true, code);
}

async function navigateP13Invitation(client: CdpClient, url: string) {
  await client.call("Page.navigate", { url });
  await waitForP13Browser(async () => await cdpValue<string>(client, "location.pathname") === "/invite", "p1_3_invitation_acceptance_browser_cdp_failed");
  await waitForP13InvitationSurface(client, "p1_3_invitation_acceptance_browser_cdp_failed");
}

async function claimP13Invitation(client: CdpClient, origin: string, token: string) {
  await navigateP13Invitation(client, `${origin}/invite#c=${encodeURIComponent(token)}`);
  await waitForP13Browser(async () => await cdpValue<boolean>(client, "document.body.innerText.includes('Invitation ready. Continue below.')") === true, "p1_3_invitation_acceptance_browser_privacy_invalid");
  await assertP13InvitationTokenPrivacy(client, token);
}

async function armP13ResponseLoss(client: CdpClient, endpoint: string) {
  let lost = false;
  let failed = false;
  const unsubscribe = client.on("Fetch.requestPaused", (params) => {
    const request = params.request as { url?: unknown } | undefined;
    const requestId = params.requestId;
    const isTarget = typeof requestId === "string" && typeof request?.url === "string" && request.url.startsWith(endpoint);
    void (async () => {
      try {
        if (isTarget && !lost) {
          lost = true;
          await client.call("Fetch.failRequest", { requestId, errorReason: "Failed" });
        } else if (typeof requestId === "string") {
          await client.call("Fetch.continueRequest", { requestId });
        }
      } catch {
        failed = true;
      }
    })();
  });
  await client.call("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Fetch", requestStage: "Response" }] });
  return async () => {
    await waitForP13Browser(async () => lost || failed, "p1_3_invitation_acceptance_browser_response_loss_not_intercepted");
    unsubscribe();
    await client.call("Fetch.disable");
    if (failed) throw new Error("p1_3_invitation_acceptance_browser_response_loss_interceptor_failed");
    if (!lost) throw new Error("p1_3_invitation_acceptance_browser_response_loss_not_intercepted");
  };
}

type P13InvitationNetworkMethod = "absent" | "post" | "other_method";
type P13InvitationNetworkStatusClass = "absent" | "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "invalid";
type P13InvitationNetworkEndpointObservation = { method: P13InvitationNetworkMethod; statusClass: P13InvitationNetworkStatusClass };
type P13InvitationRecoveryNetworkObservation = { reserve: P13InvitationNetworkEndpointObservation; submit: P13InvitationNetworkEndpointObservation };

function p13InvitationNetworkStatusClass(status: unknown): P13InvitationNetworkStatusClass {
  if (typeof status !== "number" || !Number.isInteger(status)) return "invalid";
  if (status >= 100 && status < 200) return "1xx";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "invalid";
}

async function armP13InvitationRecoveryNetworkObserver(client: CdpClient) {
  const observed: P13InvitationRecoveryNetworkObservation = {
    reserve: { method: "absent", statusClass: "absent" },
    submit: { method: "absent", statusClass: "absent" }
  };
  const requests = new Map<string, "reserve" | "submit">();
  const endpointFor = (url: unknown) => {
    if (typeof url !== "string") return undefined;
    try {
      const path = new URL(url).pathname;
      if (path === "/api/invitations/recovery/enrollment/reserve") return "reserve" as const;
      if (path === "/api/invitations/recovery/enrollment/submit") return "submit" as const;
    } catch {}
    return undefined;
  };
  const requestUnsubscribe = client.on("Network.requestWillBeSent", (params) => {
    const request = params.request as { url?: unknown; method?: unknown } | undefined;
    const requestId = params.requestId;
    const endpoint = endpointFor(request?.url);
    if (!endpoint || typeof requestId !== "string") return;
    observed[endpoint].method = request?.method === "POST" ? "post" : "other_method";
    requests.set(requestId, endpoint);
  });
  const responseUnsubscribe = client.on("Network.responseReceived", (params) => {
    const requestId = params.requestId;
    if (typeof requestId !== "string") return;
    const endpoint = requests.get(requestId);
    if (!endpoint) return;
    observed[endpoint].statusClass = p13InvitationNetworkStatusClass((params.response as { status?: unknown } | undefined)?.status);
    requests.delete(requestId);
  });
  try {
    await client.call("Network.enable");
  } catch (error) {
    requestUnsubscribe(); responseUnsubscribe(); requests.clear();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return observed;
    released = true;
    requestUnsubscribe(); responseUnsubscribe(); requests.clear();
    try { await client.call("Network.disable"); } catch { throw new Error("p1_3_invitation_acceptance_browser_cdp_failed"); }
    return observed;
  };
}

type P13InvitationRecoverySchemaStatusClass = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "invalid";
type P13InvitationRecoverySchemaOk = "true" | "false" | "absent";
type P13InvitationRecoverySchemaData = "present" | "absent";
type P13InvitationRecoverySchemaTerminal = "generated" | "completed" | "unavailable" | "other" | "absent";
type P13InvitationRecoverySchemaCount = "exactly_10" | "other" | "absent";
type P13InvitationRecoverySchemaShape = "valid" | "invalid";
type P13InvitationRecoverySchemaObservation = { statusClass: P13InvitationRecoverySchemaStatusClass; ok: P13InvitationRecoverySchemaOk; data: P13InvitationRecoverySchemaData; terminal: P13InvitationRecoverySchemaTerminal; count: P13InvitationRecoverySchemaCount; shape: P13InvitationRecoverySchemaShape };

function p13InvitationRecoverySchemaObservation(value: unknown): P13InvitationRecoverySchemaObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const statusClass = record.statusClass;
  const ok = record.ok;
  const data = record.data;
  const terminal = record.terminal;
  const count = record.count;
  const shape = record.shape;
  if (statusClass !== "1xx" && statusClass !== "2xx" && statusClass !== "3xx" && statusClass !== "4xx" && statusClass !== "5xx" && statusClass !== "invalid") return undefined;
  if (ok !== "true" && ok !== "false" && ok !== "absent") return undefined;
  if (data !== "present" && data !== "absent") return undefined;
  if (terminal !== "generated" && terminal !== "completed" && terminal !== "unavailable" && terminal !== "other" && terminal !== "absent") return undefined;
  if (count !== "exactly_10" && count !== "other" && count !== "absent") return undefined;
  if (shape !== "valid" && shape !== "invalid") return undefined;
  return { statusClass: statusClass as P13InvitationRecoverySchemaStatusClass, ok: ok as P13InvitationRecoverySchemaOk, data: data as P13InvitationRecoverySchemaData, terminal: terminal as P13InvitationRecoverySchemaTerminal, count: count as P13InvitationRecoverySchemaCount, shape: shape as P13InvitationRecoverySchemaShape };
}

async function armP13InvitationRecoverySchemaObserver(client: CdpClient) {
  const bindingName = "__cubbyP13RecoverySchemaObserver";
  let observed: P13InvitationRecoverySchemaObservation | undefined;
  let malformed = false;
  const unsubscribe = client.on("Runtime.bindingCalled", (params) => {
    if (params.name !== bindingName || typeof params.payload !== "string") return;
    try {
      const parsed = p13InvitationRecoverySchemaObservation(JSON.parse(params.payload));
      if (!parsed) malformed = true;
      else observed = parsed;
    } catch { malformed = true; }
  });
  try {
    await client.call("Runtime.enable");
    await client.call("Runtime.addBinding", { name: bindingName });
  } catch (error) {
    unsubscribe();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return malformed ? undefined : observed;
    released = true;
    unsubscribe();
    try { await client.call("Runtime.removeBinding", { name: bindingName }); } catch { throw new Error("p1_3_invitation_acceptance_browser_cdp_failed"); }
    return malformed ? undefined : observed;
  };
}

function p13InvitationRecoverySchemaFailureCode(observed: P13InvitationRecoverySchemaObservation | undefined) {
  if (!observed) return "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_schema_observer_absent_failed";
  return `p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_schema_${observed.statusClass}_${observed.ok}_${observed.data}_${observed.terminal}_${observed.count}_${observed.shape}_failed`;
}

type P13InvitationRecoveryOrigin = "setup_session_absent" | "setup_corridor_rejected" | "submit_service_error" | "submit_empty_receipt" | "submit_terminal_unavailable" | "submit_terminal_generated" | "submit_terminal_completed" | "submit_state_fresh_auth_bound" | "submit_state_prepared" | "submit_state_other" | "submit_receipt_invalid" | "submit_server_legacy_invalid" | "submit_header_unsupported" | "observer_absent";

function p13InvitationRecoveryOriginObservation(value: unknown): P13InvitationRecoveryOrigin {
  return value === "setup_session_absent" || value === "setup_corridor_rejected" || value === "submit_service_error" || value === "submit_empty_receipt" || value === "submit_terminal_unavailable" || value === "submit_terminal_generated" || value === "submit_terminal_completed" || value === "submit_state_fresh_auth_bound" || value === "submit_state_prepared" || value === "submit_state_other" || value === "submit_receipt_invalid" || value === "submit_server_legacy_invalid" || value === "submit_header_unsupported" || value === "observer_absent" ? value : "submit_header_unsupported";
}

async function armP13InvitationRecoveryOriginObserver(client: CdpClient) {
  const bindingName = "__cubbyP13RecoveryOriginObserver";
  let observed: P13InvitationRecoveryOrigin = "observer_absent";
  const unsubscribe = client.on("Runtime.bindingCalled", (params) => {
    if (params.name === bindingName && typeof params.payload === "string") observed = p13InvitationRecoveryOriginObservation(params.payload);
  });
  try {
    await client.call("Runtime.enable");
    await client.call("Runtime.addBinding", { name: bindingName });
  } catch (error) {
    unsubscribe();
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return observed;
    released = true;
    unsubscribe();
    try { await client.call("Runtime.removeBinding", { name: bindingName }); } catch { throw new Error("p1_3_invitation_acceptance_browser_cdp_failed"); }
    return observed;
  };
}

function p13InvitationRecoveryOriginFailureCode(observed: P13InvitationRecoveryOrigin) {
  return `p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_origin_${observed}_failed`;
}

function p13InvitationRecoveryNetworkFailureCode(observed: P13InvitationRecoveryNetworkObservation) {
  for (const endpoint of ["submit", "reserve"] as const) {
    const entry = observed[endpoint];
    if (entry.statusClass !== "absent") return `p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_${endpoint}_response_${entry.statusClass}_failed`;
    if (entry.method !== "absent") return `p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_${endpoint}_${entry.method}_no_response_failed`;
  }
  return "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_network_absent_failed";
}

async function signInP13InvitationRecipient(client: CdpClient, recipient: InvitationRecipient, classifyNewUserFailure = false, flow: "new_user" | "existing_recipient" = "new_user") {
  let stage: "open" | "submit" | "review" = "open";
  try {
    await keyboardActivateP13BrowserText(client, "Sign in to continue");
    await waitForP13Browser(async () => await cdpValue<string>(client, "location.pathname") === "/login", "p1_3_invitation_acceptance_browser_cdp_failed");
    stage = "submit";
    await setP13BrowserInput(client, 'input[name="email"]', recipient.email);
    await setP13BrowserInput(client, 'input[name="password"]', recipient.password);
    await keyboardActivateP13BrowserText(client, "Sign in");
    try {
      await waitForP13Browser(async () => await cdpValue<string>(client, "location.pathname") === "/invite", "p1_3_invitation_acceptance_browser_cdp_failed", 360);
    } catch (error) {
      if (!classifyNewUserFailure) throw error;
      const terminal = await cdpValue<"form_error" | "dispatch_pending" | "neutral_landing" | "navigation_failed">(client, `(() => {
        if (document.querySelector('[role="alert"]')) return "form_error";
        if (location.pathname === "/invite/dispatch") return "dispatch_pending";
        if (location.pathname === "/") return "neutral_landing";
        return "navigation_failed";
      })()`).catch(() => "navigation_failed" as const);
      const status = terminal === "form_error"
        ? await cdpValue<number>(client, `(() => {
          const entry = performance.getEntriesByType("resource").findLast((candidate) => candidate.name.endsWith("/api/auth/sign-in/email"));
          const responseStatus = entry && Reflect.get(entry, "responseStatus");
          return typeof responseStatus === "number" ? responseStatus : 0;
        })()`).catch(() => 0)
        : 0;
      throw new Error(p13InvitationNewUserSignInSubmitTerminalFailureCode(terminal, status, flow));
    }
    stage = "review";
    await waitForP13Browser(async () => await cdpValue<boolean>(client, "document.body.innerText.includes('Review your invitation')") === true, "p1_3_invitation_acceptance_browser_cdp_failed");
  } catch (error) {
    if (!classifyNewUserFailure) throw error;
    throw new Error(p13InvitationNewUserSignInFailureCode(stage, error, flow));
  }
}

async function rehearseAndAcceptP13Invitation(client: CdpClient, recipient: InvitationRecipient, requiresAdminAcknowledgement: boolean, classifyNewUserFailure = false, flow: "new_user" | "existing_recipient" = "new_user") {
  let stage: P13InvitationNewUserAcceptanceStage = "recovery_generate";
  let releaseNetworkObserver: (() => Promise<P13InvitationRecoveryNetworkObservation>) | undefined;
  let releaseOriginObserver: (() => Promise<P13InvitationRecoveryOrigin>) | undefined;
  try {
    // The failure observer must only see resources caused by this action; prior app
    // navigation can otherwise fill the browser's finite resource-timing buffer.
    await cdpValue<boolean>(client, "(() => { performance.clearResourceTimings(); return true; })()");
    if (classifyNewUserFailure && flow === "new_user") {
      releaseNetworkObserver = await armP13InvitationRecoveryNetworkObserver(client);
      releaseOriginObserver = await armP13InvitationRecoveryOriginObserver(client);
    }
    await setP13BrowserInput(client, 'input[autocomplete="current-password"]', recipient.password);
    await touchActivateP13BrowserText(client, "Generate recovery codes");
    await waitForP13Browser(async () => await cdpValue<boolean>(client, "Boolean(document.querySelector('[aria-label=\"Display-once recovery codes\"]'))") === true, "p1_3_invitation_acceptance_browser_cdp_failed");
    const focused = await cdpValue<boolean>(client, "document.activeElement?.getAttribute('aria-label') === 'Display-once recovery codes'");
    if (!focused) throw new Error("p1_3_invitation_acceptance_browser_geometry_invalid");

    stage = "recovery_copy";
    await touchActivateP13BrowserSelector(client, '[aria-label="Display-once recovery codes"] button');
    await assertP13Browser(client, "Boolean(document.querySelector('input[name=\\\"recoveryCode\\\"]'))", "p1_3_invitation_acceptance_browser_cdp_failed");
    const copied = await cdpValue<boolean>(client, `(() => { const code = document.querySelector('[aria-label="Display-once recovery codes"] button')?.textContent; const input = document.querySelector('input[name="recoveryCode"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set; if (!code || !(input instanceof HTMLInputElement) || !set) return false; set.call(input, code); input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    if (!copied) throw new Error("p1_3_invitation_acceptance_browser_cdp_failed");

    stage = "recovery_confirm";
    await setP13BrowserInput(client, 'input[name="acknowledgement"]', "I SAVED MY RECOVERY CODES");
    await keyboardActivateP13BrowserText(client, "Confirm recovery readiness");
    await waitForP13Browser(async () => await cdpValue<boolean>(client, "document.body.innerText.includes('Recovery readiness complete: exactly nine unused codes remain.')") === true, "p1_3_invitation_acceptance_browser_cdp_failed");

    stage = "invitation_accept";
    await setP13BrowserInput(client, 'input[name="householdName"]', recipient.householdName);
    if (requiresAdminAcknowledgement) await setP13BrowserInput(client, 'input[name="adminAcknowledgement"]', "I UNDERSTAND ADMIN ACCESS");
    await keyboardActivateP13BrowserText(client, "Accept invitation");

    stage = "post_accept_navigation";
    await waitForP13Browser(async () => await cdpValue<string>(client, "location.pathname") === "/app", "p1_3_invitation_acceptance_browser_cdp_failed", 360);
  } catch (error) {
    if (!classifyNewUserFailure) throw error;
    if (stage === "recovery_generate" && releaseOriginObserver) throw new Error(p13InvitationRecoveryOriginFailureCode(await releaseOriginObserver()));

    if (stage === "recovery_generate" && releaseNetworkObserver) throw new Error(p13InvitationRecoveryNetworkFailureCode(await releaseNetworkObserver()));
    if (stage === "recovery_generate") throw new Error(await p13InvitationRecoveryGenerationFailureCode(client, error, flow));
    throw new Error(flow === "new_user" ? p13InvitationNewUserAcceptanceFailureCode(stage, error) : p13InvitationExistingRecipientAcceptanceFailureCode(stage, error));
  } finally {
    if (releaseNetworkObserver) await releaseNetworkObserver();

    if (releaseOriginObserver) await releaseOriginObserver();
  }
}

async function runNewP13InvitationWorkflow(client: CdpClient, origin: string, recipient: InvitationRecipient) {
  let token = recipient.invitationToken;
  let stage: "claim" | "credentials" | "sign_in" | "acceptance" = "claim";
  recipient.invitationToken = "";
  try {
    await setP13BrowserViewport(client, 375, 812, true);
    await claimP13Invitation(client, origin, token);
    token = "";
    await assertP13InvitationGeometry(client);
    await setP13BrowserViewport(client, 1280, 900, false);
    await assertP13InvitationGeometry(client);
    await setP13BrowserViewport(client, 375, 812, true);
    stage = "credentials";
    const releaseResponseLoss = await armP13ResponseLoss(client, `${origin}/api/invitations/credentials/submit`);
    await setP13BrowserInput(client, 'input[name="displayName"]', recipient.displayName);
    await setP13BrowserInput(client, 'input[name="email"]', recipient.email);
    await setP13BrowserInput(client, 'input[name="password"]', recipient.password);
    await keyboardActivateP13BrowserText(client, "Create sign-in details");
    await releaseResponseLoss();
    await waitForP13Browser(async () => await cdpValue<boolean>(client, "sessionStorage.getItem('cubby:invitation-workflow-operation:v1') !== null") === true, "p1_3_invitation_acceptance_browser_response_loss_retained_not_written");
    await client.call("Page.reload", { ignoreCache: true });
    await waitForP13InvitationSurface(client, "p1_3_invitation_acceptance_browser_response_loss_surface_not_restored");
    await waitForP13Browser(async () => await cdpValue<boolean>(client, "Boolean(document.querySelector('[aria-label=\"Retained invitation operation\"]'))") === true, "p1_3_invitation_acceptance_browser_response_loss_retained_operation_not_rendered");
    await keyboardActivateP13BrowserText(client, "Check retained step status");
    await waitForP13Browser(async () => await cdpValue<boolean>(client, "document.body.innerText.includes('Credentials are ready. Sign in to continue the invitation.')") === true, "p1_3_invitation_acceptance_browser_response_loss_status_not_recovered");
    stage = "sign_in";
    await signInP13InvitationRecipient(client, recipient, true);
    stage = "acceptance";
    await rehearseAndAcceptP13Invitation(client, recipient, false, true);
  } catch (error) {
    throw new Error(p13InvitationNewUserWorkflowFailureCode(stage, error));
  } finally {
    token = "";
  }
}

/**
 * Returns the browser to a signed-out, storage-free state for the next distinct recipient. It parks on
 * /login rather than /invite so the following claim navigation to /invite#c=... is a real document load;
 * landing on /invite first would make that a fragment-only change, leaving the bootstrap effect unrun
 * and the token never consumed.
 */
async function resetP13BrowserSession(client: CdpClient, origin: string) {
  try {
    await client.call("Network.clearBrowserCookies");
    await client.call("Page.navigate", { url: `${origin}/login` });
  } catch {
    throw new Error("p1_3_invitation_acceptance_browser_existing_recipient_session_reset_failed");
  }
  await waitForP13Browser(async () => await cdpValue<boolean>(client, "document.readyState === 'complete' && location.pathname === '/login'") === true, "p1_3_invitation_acceptance_browser_existing_recipient_session_reset_failed");
  const cleared = await cdpValue<boolean>(client, '(() => { try { sessionStorage.clear(); localStorage.clear(); } catch { return false; } return document.cookie === "" && sessionStorage.length === 0 && localStorage.length === 0; })()');
  if (!cleared) throw new Error("p1_3_invitation_acceptance_browser_existing_recipient_session_reset_failed");
}

async function runExistingP13InvitationWorkflow(client: CdpClient, origin: string, recipient: InvitationRecipient) {
  let token = recipient.invitationToken;
  let stage: "session_reset" | "claim" | "geometry" | "sign_in" | "acceptance" = "session_reset";
  recipient.invitationToken = "";
  try {
    await setP13BrowserViewport(client, 375, 812, true);
    // The existing recipient is a different person on their own browser. The preceding new-user flow
    // ends signed in, so its cookies and storage are cleared first; otherwise this flow would attempt a
    // credential sign-in while another account's session is still live, which no real recipient does.
    stage = "session_reset";
    await resetP13BrowserSession(client, origin);
    stage = "claim";
    await claimP13Invitation(client, origin, token);
    token = "";
    stage = "geometry";
    await assertP13InvitationGeometry(client);
    await setP13BrowserViewport(client, 1280, 900, false);
    await assertP13InvitationGeometry(client);
    await setP13BrowserViewport(client, 375, 812, true);
    stage = "sign_in";
    await signInP13InvitationRecipient(client, recipient, true, "existing_recipient");
    stage = "acceptance";
    await rehearseAndAcceptP13Invitation(client, recipient, true, true, "existing_recipient");
  } catch (error) {
    throw new Error(p13InvitationExistingRecipientWorkflowFailureCode(stage, error));
  } finally {
    token = "";
  }
}

async function terminateP13Browser(process: ChildProcess) {
  if (!process.pid || process.exitCode !== null || process.signalCode !== null) return true;
  const result = spawnSync("taskkill.exe", ["/PID", process.pid.toString(), "/T", "/F"], { stdio: "ignore" });
  if (result.error || result.status !== 0) process.kill();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (process.exitCode !== null || process.signalCode !== null) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return process.exitCode !== null || process.signalCode !== null;
}

async function launchP13Browser(profile: string) {
  const executable = browserExecutables.find(existsSync);
  if (!executable) throw new Error("p1_3_invitation_acceptance_browser_missing");
  const process = spawn(executable, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--ignore-certificate-errors", "--allow-insecure-localhost", "about:blank"], { env: hostExecutableEnvironment(), stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    process.once("spawn", resolveSpawn);
    process.once("error", () => rejectSpawn(new Error("p1_3_invitation_acceptance_browser_start_failed")));
  });
  return { process };
}

async function startP13InvitationTlsProxy(key: Buffer, cert: Buffer) {
  let upstreamPort: number | undefined;
  const server = createHttpsServer({ key, cert }, (incoming: IncomingMessage, outgoing: ServerResponse) => {
    if (!upstreamPort) { outgoing.statusCode = 503; outgoing.end(); return; }
    const upstream = httpRequest({ host: "127.0.0.1", port: upstreamPort, method: incoming.method, path: incoming.url, headers: { ...incoming.headers, "x-forwarded-proto": "https", "x-forwarded-host": incoming.headers.host ?? "" } }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.statusCode = 502; outgoing.end(); });
    outgoing.once("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("p1_3_invitation_acceptance_browser_tls_proxy_failed");
  return {
    origin: `https://127.0.0.1:${address.port}`,
    setUpstream(port: number) { upstreamPort = port; },
    close: () => new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
  };
}

function configureP13InvitationBrowserEnvironment(context: RunContext, database: string, origin: string) {
  const ownerUrl = postgresUrl(context.env.CUBBY_BROWSER_OPERATION_ACCEPTANCE_USER!, context.migratorPassword, "postgres:5432", database);
  const byRole = (role: string) => roleUrl(ownerUrl, role, context.rolePasswords[role]!);
  context.env = {
    ...context.env,
    CUBBY_P13_INVITATION_RUNTIME_DATABASE_URL: byRole("cubby_runtime"),
    CUBBY_P13_INVITATION_AUTH_DATABASE_URL: byRole("cubby_auth"),
    CUBBY_P13_INVITATION_EMAIL_DELIVERY_DATABASE_URL: byRole("cubby_email_delivery"),
    CUBBY_P13_INVITATION_MIGRATION_DATABASE_URL: ownerUrl,
    CUBBY_P13_INVITATION_DATABASE_URL: byRole("cubby_invitation_runtime"),
    CUBBY_P13_INVITATION_EXPIRY_DATABASE_URL: byRole("cubby_invitation_expiry_worker"),
    CUBBY_P13_INVITATION_MAINTENANCE_DATABASE_URL: byRole("cubby_invitation_maintenance_worker"),
    CUBBY_P13_INVITATION_APP_RUNTIME_DB_PASSWORD: context.rolePasswords.cubby_runtime,
    CUBBY_P13_INVITATION_APP_AUTH_DB_PASSWORD: context.rolePasswords.cubby_auth,
    CUBBY_P13_INVITATION_APP_EMAIL_DELIVERY_DB_PASSWORD: context.rolePasswords.cubby_email_delivery,
    CUBBY_P13_INVITATION_APP_SECURITY_OPERATOR_DB_PASSWORD: context.rolePasswords.cubby_security_operator,
    CUBBY_P13_INVITATION_PROTOCOL_RUNTIME_DB_PASSWORD: context.rolePasswords.cubby_invitation_runtime,
    CUBBY_P13_INVITATION_PROTOCOL_EXPIRY_DB_PASSWORD: context.rolePasswords.cubby_invitation_expiry_worker,
    CUBBY_P13_INVITATION_PROTOCOL_MAINTENANCE_DB_PASSWORD: context.rolePasswords.cubby_invitation_maintenance_worker,
    CUBBY_P13_INVITATION_FRESH_AUTH_KEYRING: `1:${context.freshAuthKeys[0]},2:${context.freshAuthKeys[1]}`,
    CUBBY_P13_INVITATION_DELIVERY_KEYRING: `1:${context.deliveryKeys[0]},2:${context.deliveryKeys[1]}`,
    CUBBY_P13_INVITATION_THROTTLE_KEY: context.throttleKey,
    CUBBY_P13_INVITATION_BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    CUBBY_P13_INVITATION_BROWSER_ORIGIN: origin,
    CUBBY_P13_INVITATION_APP_IMAGE: `${context.project}-app`,
    CUBBY_P13_INVITATION_STATUS_ROOT: context.startupStatusRoot,
    NEXT_PUBLIC_CUBBY_P13_RECOVERY_SCHEMA_OBSERVER: "1",
    CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER: "1"
  };
}

async function withP13InvitationEnvironment<T>(environment: NodeJS.ProcessEnv, action: () => Promise<T>) {
  const prior = process.env;
  process.env = { ...environment };
  try { return await action(); } finally { process.env = prior; }
}

async function verifyP13InvitationBrowserOperationInfrastructure(context: RunContext) {
  if (!context.databaseUrl) throw new Error("p1_3_invitation_acceptance_browser_operation_infrastructure_invalid");
  const runtimeDatabaseUrl = roleUrl(context.databaseUrl, "cubby_runtime", context.rolePasswords.cubby_runtime);
  try {
    await withP13InvitationEnvironment({ ...context.env, NODE_ENV: "production", DATABASE_URL: runtimeDatabaseUrl }, async () => {
      const { verifyBrowserOperationInfrastructure } = await import("../src/server/services/browser-operation-integrity");
      const { prisma } = await import("../src/lib/db/prisma");
      try {
        await verifyBrowserOperationInfrastructure();
      } finally {
        await prisma.$disconnect();
      }
    });
  } catch {
    throw new Error("p1_3_invitation_acceptance_browser_operation_infrastructure_invalid");
  }
}

function p13InvitationAppStartupFailureCode(context: RunContext) {
  const statusPath = resolve(context.startupStatusRoot, "startup");
  if (!existsSync(statusPath)) return "p1_3_invitation_acceptance_browser_app_startup_status_missing";
  let status: string;
  try {
    const value = readFileSync(statusPath, "utf8");
    if (!value.endsWith("\n")) return "p1_3_invitation_acceptance_browser_app_startup_status_invalid";
    status = value.slice(0, -1);
  } catch {
    return "p1_3_invitation_acceptance_browser_app_startup_status_invalid";
  }
  const failureCodes: Readonly<Record<string, string>> = {
    "readiness_guard|failed": "p1_3_invitation_acceptance_browser_app_readiness_guard_failed",
    "configuration|failed": "p1_3_invitation_acceptance_browser_app_configuration_failed",
    "runtime_role|failed": "p1_3_invitation_acceptance_browser_app_runtime_role_failed",
    "invitation_runtime_roles|failed": "p1_3_invitation_acceptance_browser_app_invitation_runtime_roles_failed",
    "migration_connection|failed": "p1_3_invitation_acceptance_browser_app_migration_connection_failed",
    "migration_apply|failed": "p1_3_invitation_acceptance_browser_app_migration_apply_failed",
    "fresh_auth_attestation_keys|failed": "p1_3_invitation_acceptance_browser_app_fresh_auth_attestation_keys_failed",
    "email_delivery_keys|failed": "p1_3_invitation_acceptance_browser_app_email_delivery_keys_failed",
    "global_security_throttle_key|failed": "p1_3_invitation_acceptance_browser_app_global_security_throttle_key_failed",
    "readiness_guard|starting": "p1_3_invitation_acceptance_browser_app_readiness_guard_incomplete",
    "migration|starting": "p1_3_invitation_acceptance_browser_app_migration_incomplete",
    "server|starting": ""
  };
  return failureCodes[status] ?? "p1_3_invitation_acceptance_browser_app_startup_status_invalid";
}

export function p13InvitationAppHealthFailureCode(status: number | undefined) {
  if (status === undefined) return "p1_3_invitation_acceptance_browser_app_health_unreachable";
  if (status === 204) return "p1_3_invitation_acceptance_browser_app_health_verifier_scope_confirmed";
  if (status === 503) return "p1_3_invitation_acceptance_browser_app_health_unavailable";
  if (status === 500) return "p1_3_invitation_acceptance_browser_app_health_route_error";
  if (status === 502) return "p1_3_invitation_acceptance_browser_tls_proxy_upstream_error";
  if (status >= 500 && status < 600) return "p1_3_invitation_acceptance_browser_app_health_server_error";
  if ([400, 401, 403, 404, 405].includes(status)) return "p1_3_invitation_acceptance_browser_app_health_client_error";
  if (status >= 300 && status < 400) return "p1_3_invitation_acceptance_browser_app_health_redirect";
  return "p1_3_invitation_acceptance_browser_app_health_status_invalid";
}

export function p13InvitationFrameworkErrorCode(output: string) {
  if (
    output.includes("Cannot find module")
    || output.includes("MODULE_NOT_FOUND")
    || output.includes("ERR_MODULE_NOT_FOUND")
    || output.includes("ERR_REQUIRE_ESM")
  ) {
    return "p1_3_invitation_acceptance_browser_framework_module_resolution_failed";
  }
  if (output.includes("ReferenceError")) return "p1_3_invitation_acceptance_browser_framework_reference_error";
  if (output.includes("TypeError")) return "p1_3_invitation_acceptance_browser_framework_type_error";
  if (output.includes("SyntaxError")) return "p1_3_invitation_acceptance_browser_framework_syntax_error";
  if (output.includes("Invariant:")) return "p1_3_invitation_acceptance_browser_framework_invariant_error";
  return "p1_3_invitation_acceptance_browser_framework_unclassified";
}

type P13InvitationRouteModuleMarkerState = "evaluated" | "absent" | "invalid";
type P13InvitationRouteHandlerMarkerState = "entered" | "absent" | "invalid";

export function p13InvitationCompiledRouteFailureCode(
  status: number,
  moduleMarker: P13InvitationRouteModuleMarkerState,
  handlerMarker: P13InvitationRouteHandlerMarkerState
) {
  if (moduleMarker === "invalid" || handlerMarker === "invalid" || (moduleMarker === "absent" && handlerMarker === "entered")) {
    return "p1_3_invitation_acceptance_browser_route_marker_state_invalid";
  }
  if (moduleMarker === "absent") return "p1_3_invitation_acceptance_browser_route_module_not_evaluated";
  if (handlerMarker === "absent") return "p1_3_invitation_acceptance_browser_route_handler_not_entered";
  if (status === 204) return "p1_3_invitation_acceptance_browser_route_entry_and_response_confirmed";
  return "p1_3_invitation_acceptance_browser_route_response_dispatch_failed";
}

type P13InvitationInstrumentationStage =
  | "absent"
  | "invalid"
  | "node_builtin_ready"
  | "bootstrap_exec_selected"
  | "preload_file_loaded"
  | "preload_guards_confirmed"
  | "standalone_server_module_entered"
  | "next_package_loaded"
  | "start_server_module_loaded"
  | "start_server_invoked"
  | "next_server_module_loaded"
  | "instrumentation_module_load_requested"
  | "module_evaluated"
  | "register_entered"
  | "modules_loaded"
  | "automated_backup_started"
  | "integrity_started"
  | "sprout_retention_started"
  | "browser_operation_retention_started"
  | "email_delivery_started"
  | "email_change_lifecycle_started";

export function p13InvitationInstrumentationStageFailureCode(status: number, stage: P13InvitationInstrumentationStage) {
  switch (stage) {
    case "absent": return "p1_3_invitation_acceptance_browser_instrumentation_builtin_probe_failed";
    case "invalid": return "p1_3_invitation_acceptance_browser_instrumentation_marker_invalid";
    case "node_builtin_ready": return "p1_3_invitation_acceptance_browser_bootstrap_exec_not_selected";
    case "bootstrap_exec_selected": return "p1_3_invitation_acceptance_browser_preload_file_not_loaded";
    case "preload_file_loaded": return "p1_3_invitation_acceptance_browser_preload_guards_not_confirmed";
    case "preload_guards_confirmed": return "p1_3_invitation_acceptance_browser_standalone_server_module_not_entered";
    case "standalone_server_module_entered": return "p1_3_invitation_acceptance_browser_next_package_not_loaded";
    case "next_package_loaded": return "p1_3_invitation_acceptance_browser_start_server_module_not_loaded";
    case "start_server_module_loaded": return "p1_3_invitation_acceptance_browser_start_server_not_invoked";
    case "start_server_invoked": return "p1_3_invitation_acceptance_browser_next_server_module_not_loaded";
    case "next_server_module_loaded": return "p1_3_invitation_acceptance_browser_instrumentation_module_not_requested";
    case "instrumentation_module_load_requested": return "p1_3_invitation_acceptance_browser_instrumentation_module_not_evaluated";
    case "module_evaluated": return "p1_3_invitation_acceptance_browser_instrumentation_register_not_entered";
    case "register_entered": return "p1_3_invitation_acceptance_browser_instrumentation_module_load_failed";
    case "modules_loaded": return "p1_3_invitation_acceptance_browser_instrumentation_automated_backup_start_failed";
    case "automated_backup_started": return "p1_3_invitation_acceptance_browser_instrumentation_integrity_start_failed";
    case "integrity_started": return "p1_3_invitation_acceptance_browser_instrumentation_sprout_retention_start_failed";
    case "sprout_retention_started": return "p1_3_invitation_acceptance_browser_instrumentation_browser_retention_start_failed";
    case "browser_operation_retention_started": return "p1_3_invitation_acceptance_browser_instrumentation_email_delivery_start_failed";
    case "email_delivery_started": return "p1_3_invitation_acceptance_browser_instrumentation_email_change_start_failed";
    case "email_change_lifecycle_started":
      return status === 204
        ? "p1_3_invitation_acceptance_browser_instrumentation_and_route_confirmed"
        : "p1_3_invitation_acceptance_browser_instrumentation_completed_route_failed";
  }
}


function p13InvitationTlsStatus(origin: string, path: string, timeoutMs = 2_000) {
  const url = new URL(origin);
  return new Promise<number>((resolveStatus, reject) => {
    const fail = () => {
      clearTimeout(timeout);
      reject(new Error("p1_3_invitation_acceptance_browser_app_health_unreachable"));
    };
    const request = httpsRequest({
      hostname: url.hostname,
      port: Number(url.port),
      path,
      method: "GET",
      rejectUnauthorized: false
    }, (response) => {
      clearTimeout(timeout);
      resolveStatus(response.statusCode ?? 0);
      response.destroy();
    });
    const timeout = setTimeout(() => {
      fail();
      request.destroy();
    }, Math.max(1, Math.min(2_000, timeoutMs)));
    request.on("error", fail);
    request.end();
  });
}

function p13InvitationInstrumentationFailureCode(context: RunContext, status: number) {
  const markerPath = resolve(context.startupStatusRoot, "instrumentation-stage");
  let stage: P13InvitationInstrumentationStage = "absent";
  if (existsSync(markerPath)) {
    try {
      switch (readFileSync(markerPath, "utf8")) {
        case "node_builtin_ready\n": stage = "node_builtin_ready"; break;
        case "bootstrap_exec_selected\n": stage = "bootstrap_exec_selected"; break;
        case "preload_file_loaded\n": stage = "preload_file_loaded"; break;
        case "preload_guards_confirmed\n": stage = "preload_guards_confirmed"; break;
        case "standalone_server_module_entered\n": stage = "standalone_server_module_entered"; break;
        case "next_package_loaded\n": stage = "next_package_loaded"; break;
        case "start_server_module_loaded\n": stage = "start_server_module_loaded"; break;
        case "start_server_invoked\n": stage = "start_server_invoked"; break;
        case "next_server_module_loaded\n": stage = "next_server_module_loaded"; break;
        case "instrumentation_module_load_requested\n": stage = "instrumentation_module_load_requested"; break;
        case "module_evaluated\n": stage = "module_evaluated"; break;
        case "register_entered\n": stage = "register_entered"; break;
        case "modules_loaded\n": stage = "modules_loaded"; break;
        case "automated_backup_started\n": stage = "automated_backup_started"; break;
        case "integrity_started\n": stage = "integrity_started"; break;
        case "sprout_retention_started\n": stage = "sprout_retention_started"; break;
        case "browser_operation_retention_started\n": stage = "browser_operation_retention_started"; break;
        case "email_delivery_started\n": stage = "email_delivery_started"; break;
        case "email_change_lifecycle_started\n": stage = "email_change_lifecycle_started"; break;
        default: stage = "invalid";
      }
    } catch {
      stage = "invalid";
    }
  }
  return p13InvitationInstrumentationStageFailureCode(status, stage);
}

async function verifyP13InvitationInstrumentationStage(context: RunContext, origin: string) {
  let status = 0;
  try {
    status = await p13InvitationTlsStatus(origin, "/api/p13-route-sentinel");
  } catch {
    status = 0;
  }
  if (status !== 204) throw new Error(p13InvitationAppHealthFailureCode(status || undefined));
  const code = p13InvitationInstrumentationFailureCode(context, status);
  if (code === "p1_3_invitation_acceptance_browser_instrumentation_and_route_confirmed") return code;
  throw new Error(code);
}

function p13InvitationBrowserWorkflowFailureCode(workflow: "new_user" | "existing_user", error: unknown) {
  if (isBrowserDiagnosticError(error)) return error.message;
  return workflow === "new_user"
    ? "p1_3_invitation_acceptance_browser_new_user_failed"
    : "p1_3_invitation_acceptance_browser_existing_user_failed";
}

function p13InvitationNewUserWorkflowFailureCode(stage: "claim" | "credentials" | "sign_in" | "acceptance", error: unknown) {
  if (isBrowserDiagnosticError(error) && error.message !== "p1_3_invitation_acceptance_browser_cdp_failed") return error.message;
  return `p1_3_invitation_acceptance_browser_new_user_${stage}_failed`;
}

type P13InvitationNewUserAcceptanceStage =
  | "recovery_generate"
  | "recovery_copy"
  | "recovery_confirm"
  | "invitation_accept"
  | "post_accept_navigation";

function p13InvitationNewUserAcceptanceFailureCode(stage: P13InvitationNewUserAcceptanceStage, error: unknown) {
  if (isBrowserDiagnosticError(error) && error.message !== "p1_3_invitation_acceptance_browser_cdp_failed") return error.message;
  return `p1_3_invitation_acceptance_browser_new_user_acceptance_${stage}_failed`;
}

function p13InvitationExistingRecipientWorkflowFailureCode(stage: "session_reset" | "claim" | "geometry" | "sign_in" | "acceptance", error: unknown) {
  if (isBrowserDiagnosticError(error) && error.message !== "p1_3_invitation_acceptance_browser_cdp_failed") return error.message;
  return `p1_3_invitation_acceptance_browser_existing_recipient_${stage}_failed`;
}

function p13InvitationExistingRecipientAcceptanceFailureCode(stage: P13InvitationNewUserAcceptanceStage, error: unknown) {
  if (isBrowserDiagnosticError(error) && error.message !== "p1_3_invitation_acceptance_browser_cdp_failed") return error.message;
  return `p1_3_invitation_acceptance_browser_existing_recipient_acceptance_${stage}_failed`;
}

type P13InvitationRecoveryGenerationStage = "enrollment_reserve" | "enrollment_submit" | "recovery_render" | "enrollment_unobserved" | "enrollment_observer_unavailable";

async function p13InvitationRecoveryGenerationFailureCode(client: CdpClient, error: unknown, flow: "new_user" | "existing_recipient" = "new_user") {
  if (isBrowserDiagnosticError(error) && error.message !== "p1_3_invitation_acceptance_browser_cdp_failed") return error.message;
  const stage = await cdpValue<P13InvitationRecoveryGenerationStage>(client, `(() => {
    const resources = performance.getEntriesByType("resource");
    const hasRequest = (suffix) => resources.some((entry) => typeof entry.name === "string" && entry.name.endsWith(suffix));
    if (document.querySelector('[aria-label="Display-once recovery codes"]')) return "recovery_render";
    if (hasRequest("/api/invitations/recovery/enrollment/submit")) return "enrollment_submit";
    if (hasRequest("/api/invitations/recovery/enrollment/reserve")) return "enrollment_reserve";
    return "enrollment_unobserved";
  })()`).catch(() => "enrollment_observer_unavailable" as const);
  return `p1_3_invitation_acceptance_browser_${flow}_recovery_${stage}_failed`;
}

function p13InvitationNewUserSignInFailureCode(stage: "open" | "submit" | "review", error: unknown, flow: "new_user" | "existing_recipient" = "new_user") {
  if (isBrowserDiagnosticError(error) && error.message !== "p1_3_invitation_acceptance_browser_cdp_failed") return error.message;
  return `p1_3_invitation_acceptance_browser_${flow}_sign_in_${stage}_failed`;
}

function p13InvitationNewUserSignInSubmitTerminalFailureCode(terminal: "form_error" | "dispatch_pending" | "neutral_landing" | "navigation_failed", status = 0, flow: "new_user" | "existing_recipient" = "new_user") {
  if (terminal === "form_error") {
    const suffix = status >= 400 && status < 500
      ? status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "client"
      : status >= 500 && status < 600 ? "server" : "unavailable";
    return `p1_3_invitation_acceptance_browser_${flow}_sign_in_submit_form_error_${suffix}`;
  }
  return `p1_3_invitation_acceptance_browser_${flow}_sign_in_submit_${terminal}`;
}

type P13InvitationNewUserSignInPersistence = "session_absent" | "session_without_event" | "session_without_activity" | "session_with_activity";
type P13InvitationCarrierFailureStage = "lookup" | "lookup-miss" | "precheck" | "handler" | "failure-recording"
  | "unauthorized-user-not-found" | "unauthorized-credential-account-not-found" | "unauthorized-email-not-verified" | "unauthorized-failed-to-create-session" | "unauthorized-other" | "handler-ok"
  | "parse" | "invalid-credentials-user-not-found" | "invalid-credentials-credential-account-not-found" | "invalid-credentials-password-not-found" | "invalid-credentials-password-mismatch" | "invalid-credentials-unclassified"
  | "unreadable";

function p13InvitationNewUserSignInPersistenceFailureCode(
  state: P13InvitationNewUserSignInPersistence,
  carrierStage?: P13InvitationCarrierFailureStage
) {
  if (state === "session_absent" && carrierStage) {
    return `p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_${carrierStage.replaceAll("-", "_")}`;
  }
  return `p1_3_invitation_acceptance_browser_new_user_sign_in_${state}`;
}

function p13InvitationCarrierFailureStage(context: RunContext): P13InvitationCarrierFailureStage | undefined {
  const markerPath = resolve(context.startupStatusRoot, "sign-in-carrier-stage");
  if (!existsSync(markerPath)) return undefined;
  try {
    const observed = readFileSync(markerPath, "utf8");
    rmSync(markerPath, { force: true });
    switch (observed) {
      case "lookup\n": return "lookup";
      case "lookup-miss\n": return "lookup-miss";
      case "unauthorized-user-not-found\n": return "unauthorized-user-not-found";
      case "unauthorized-credential-account-not-found\n": return "unauthorized-credential-account-not-found";
      case "unauthorized-email-not-verified\n": return "unauthorized-email-not-verified";
      case "unauthorized-failed-to-create-session\n": return "unauthorized-failed-to-create-session";
      case "unauthorized-other\n": return "unauthorized-other";
      case "precheck\n": return "precheck";
      case "handler\n": return "handler";
      case "failure-recording\n": return "failure-recording";
      case "handler-ok\n": return "handler-ok";
      case "parse\n": return "parse";
      case "invalid-credentials-user-not-found\n": return "invalid-credentials-user-not-found";
      case "invalid-credentials-credential-account-not-found\n": return "invalid-credentials-credential-account-not-found";
      case "invalid-credentials-password-not-found\n": return "invalid-credentials-password-not-found";
      case "invalid-credentials-password-mismatch\n": return "invalid-credentials-password-mismatch";
      case "invalid-credentials-unclassified\n": return "invalid-credentials-unclassified";
      // Present but unrecognized content is not absence; report it as its own fixed category.
      default: return "unreadable";
    }
  } catch {
    try { rmSync(markerPath, { force: true }); } catch {}
    return "unreadable";
  }
}

type P13ExistingRecipientSignInDenial = "credential_account_absent" | "session_created" | "throttle_quiet" | "failure_recorded_only" | "no_evidence";

/** Reduces an existing-recipient sign-in denial to one fixed category. Emits no row content. */
function p13InvitationExistingRecipientSignInDenialCode(context: RunContext, recipient: InvitationRecipient) {
  // The app writes a carrier-stage marker when the throttle carrier itself observes a failure, which
  // separates a missed user lookup from Better Auth rejecting the credentials. Prefer it when present.
  const carrierStage = p13InvitationCarrierFailureStage(context);
  if (carrierStage) return `p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_${carrierStage.replaceAll("-", "_")}`;
  const email = recipient.email.replaceAll("'", "''");
  const observed = run("docker", psqlArguments(context, `
    WITH subject AS (SELECT "id" FROM public."User" WHERE lower("email")=lower('${email}')), observed AS (
      SELECT
        EXISTS (SELECT 1 FROM public."Account" account_row JOIN subject ON subject."id"=account_row."userId" WHERE account_row."providerId"='credential' AND account_row."password" IS NOT NULL) AS credential_present,
        EXISTS (SELECT 1 FROM public."Session" session_row JOIN subject ON subject."id"=session_row."userId") AS session_present,
        EXISTS (SELECT 1 FROM public."GlobalSecurityIncident" WHERE "state"='quiet') AS quiet_present,
        EXISTS (SELECT 1 FROM public."GlobalSecurityEvent" event_row JOIN subject ON subject."id"=event_row."userId" WHERE event_row."eventType"='credential' AND event_row."outcome"='sign_in_failed') AS failure_present
    )
    SELECT CASE WHEN NOT credential_present THEN 'credential_account_absent' WHEN session_present THEN 'session_created' WHEN quiet_present THEN 'throttle_quiet' WHEN failure_present THEN 'failure_recorded_only' ELSE 'no_evidence' END FROM observed;
  `), context.env, "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_denial_probe_failed");
  // The probe code is a fixed observation so its category is returned; a query failure has its own code.
  const denial: P13ExistingRecipientSignInDenial = observed === "credential_account_absent" || observed === "session_created" || observed === "throttle_quiet" || observed === "failure_recorded_only" ? observed : "no_evidence";
  return `p1_3_invitation_acceptance_browser_existing_recipient_sign_in_denial_${denial}`;
}

function p13InvitationNewUserSignInPersistenceState(context: RunContext, recipient: InvitationRecipient): P13InvitationNewUserSignInPersistence {
  const normalizedEmail = recipient.email.replaceAll("'", "''");
  const state = run("docker", psqlArguments(context, `
    WITH subject AS (
      SELECT "id" FROM public."User" WHERE lower("email")=lower('${normalizedEmail}')
    ), observed AS (
      SELECT
        EXISTS (SELECT 1 FROM public."Session" session_row JOIN subject ON subject."id"=session_row."userId") AS session_exists,
        EXISTS (SELECT 1 FROM public."Session" session_row JOIN subject ON subject."id"=session_row."userId" JOIN public."GlobalSecurityEvent" event_row ON event_row."userId"=session_row."userId" WHERE event_row."eventType"='credential' AND event_row."outcome"='sign_in_succeeded') AS event_exists,
        EXISTS (SELECT 1 FROM public."Session" session_row JOIN subject ON subject."id"=session_row."userId" JOIN public."SessionSecurityActivity" activity_row ON activity_row."sessionId"=session_row."id") AS activity_exists
    )
    SELECT CASE WHEN NOT session_exists THEN 'session_absent' WHEN NOT event_exists THEN 'session_without_event' WHEN NOT activity_exists THEN 'session_without_activity' ELSE 'session_with_activity' END FROM observed;
  `), context.env, "p1_3_invitation_acceptance_browser_new_user_sign_in_postcondition_probe_failed");
  if (state === "session_absent" || state === "session_without_event" || state === "session_without_activity" || state === "session_with_activity") return state;
  throw new Error("p1_3_invitation_acceptance_browser_new_user_sign_in_postcondition_probe_failed");
}

function p13InvitationNewUserSignInPostconditionFailureCode(context: RunContext, recipient: InvitationRecipient) {
  const state = p13InvitationNewUserSignInPersistenceState(context, recipient);
  if (state !== "session_absent") return p13InvitationNewUserSignInPersistenceFailureCode(state);
  return p13InvitationNewUserSignInPersistenceFailureCode(state, p13InvitationCarrierFailureStage(context));
}

async function waitForP13InvitationAppHealth(context: RunContext, origin: string) {
  const deadline = performance.now() + 60_000;
  let status: number | undefined;
  while (performance.now() < deadline) {
    const startupFailure = p13InvitationAppStartupFailureCode(context);
    if (startupFailure.endsWith("_failed")) throw new Error(startupFailure);
    try {
      status = await p13InvitationTlsStatus(origin, "/api/health", deadline - performance.now());
      if (!startupFailure && (status === 200 || status === 204)) return;
    } catch {
      status = undefined;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.max(0, Math.min(100, deadline - performance.now()))));
  }
  const startupFailure = p13InvitationAppStartupFailureCode(context);
  if (startupFailure) throw new Error(startupFailure);
  if (status === 500) throw new Error(p13InvitationInstrumentationFailureCode(context, status));
  throw new Error(p13InvitationAppHealthFailureCode(status));
}

async function runP13InvitationBrowserCdp(context: RunContext, compose: readonly string[], database: string, mode: "acceptance" | "diagnostic" = "diagnostic") {
  const keyPath = resolve(context.temporaryRoot, "browser-key.pem");
  const certificatePath = resolve(context.temporaryRoot, "browser-cert.pem");
  const profile = resolve(context.temporaryRoot, "browser-profile");
  let proxy: Awaited<ReturnType<typeof startP13InvitationTlsProxy>> | undefined;
  let browser: ChildProcess | undefined;
  let client: CdpClient | undefined;
  let fixtures: P13InvitationBrowserFixtures | undefined;
  let fixtureModule: typeof import("./p1-3-invitation-browser-fixtures") | undefined;
  let failure: Error | undefined;
  let cleanupFailed = false;
  try {
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certificatePath, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], context.env, "p1_3_invitation_acceptance_browser_certificate_failed");
    proxy = await startP13InvitationTlsProxy(readFileSync(keyPath), readFileSync(certificatePath));
    configureP13InvitationBrowserEnvironment(context, database, proxy.origin);
    await verifyP13InvitationBrowserOperationInfrastructure(context);
    buildP13InvitationAppStage(context, "deps", "p1_3_invitation_acceptance_browser_app_dependencies_build_failed");
    buildP13InvitationAppStage(context, "builder", "p1_3_invitation_acceptance_browser_app_builder_build_failed");
    buildP13InvitationAppStage(context, "runner-dependencies", "p1_3_invitation_acceptance_browser_app_runtime_dependencies_prune_failed");
    buildP13InvitationAppStage(context, "runner-public", "p1_3_invitation_acceptance_browser_app_runner_public_failed");
    buildP13InvitationAppStage(context, "runner-standalone", "p1_3_invitation_acceptance_browser_app_runner_standalone_failed");
    buildP13InvitationAppStage(context, "runner-static", "p1_3_invitation_acceptance_browser_app_runner_static_failed");
    buildP13InvitationAppStage(context, "runner-runtime-artifacts", "p1_3_invitation_acceptance_browser_app_runner_runtime_artifacts_failed");
    buildP13InvitationAppStage(context, "runner-filesystem", "p1_3_invitation_acceptance_browser_app_runner_filesystem_failed");
    buildP13InvitationAppImage(context);
    run("docker", [...compose, "up", "--detach", "--wait", "app"], context.env, "p1_3_invitation_acceptance_browser_app_start_failed");
    const published = run("docker", [...compose, "port", "app", "3000"], context.env, "p1_3_invitation_acceptance_browser_app_port_failed");
    if (!/^127\.0\.0\.1:\d+$/.test(published)) throw new Error("p1_3_invitation_acceptance_browser_loopback_invalid");
    const appPort = Number(published.slice("127.0.0.1:".length));
    proxy.setUpstream(appPort);

    await waitForP13InvitationAppHealth(context, proxy.origin);
    await verifyP13InvitationInstrumentationStage(context, proxy.origin);
    if (mode === "acceptance") {
      fixtureModule = await withP13InvitationEnvironment(context.env, () => import("./p1-3-invitation-browser-fixtures"));
      fixtures = await withP13InvitationEnvironment(context.env, () => fixtureModule!.createP13InvitationBrowserFixtures()).catch((error) => {
        throw new Error(isBrowserDiagnosticError(error) ? error.message : "p1_3_invitation_acceptance_browser_fixture_failed");
      });
      const launched = await launchP13Browser(resolve(context.temporaryRoot, "browser-profile"));
      browser = launched.process;
      client = await connectP13InvitationCdp(browser);
      await Promise.all([client.call("Page.enable"), client.call("Runtime.enable"), client.call("Fetch.disable")]);
      rmSync(resolve(context.startupStatusRoot, "sign-in-carrier-stage"), { force: true });
      await runNewP13InvitationWorkflow(client, proxy.origin, fixtures.newUser).catch((error) => {
        const failureCode = p13InvitationBrowserWorkflowFailureCode("new_user", error);
        if (failureCode === "p1_3_invitation_acceptance_browser_new_user_sign_in_submit_form_error_server") {
          throw new Error(p13InvitationNewUserSignInPostconditionFailureCode(context, fixtures!.newUser));
        }
        throw new Error(failureCode);
      });
      const positiveControl = p13InvitationCarrierFailureStage(context);
      if (positiveControl === undefined) throw new Error("p1_3_invitation_acceptance_browser_positive_control_absent");
      if (positiveControl === "unreadable") throw new Error("p1_3_invitation_acceptance_browser_positive_control_unreadable");
      if (positiveControl !== "handler-ok") throw new Error("p1_3_invitation_acceptance_browser_positive_control_unexpected");
      await runExistingP13InvitationWorkflow(client, proxy.origin, fixtures.existingUser).catch((error) => {
        const failureCode = p13InvitationBrowserWorkflowFailureCode("existing_user", error);
        if (failureCode === "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_submit_form_error_unauthorized") {
          throw new Error(p13InvitationExistingRecipientSignInDenialCode(context, fixtures!.existingUser));
        }
        throw new Error(failureCode);
      });
    }
  } catch (error) {
    failure = isBrowserDiagnosticError(error) ? error : new Error("p1_3_invitation_acceptance_browser_cdp_failed");
  } finally {
    client?.close();
    if (browser && !(await terminateP13Browser(browser))) cleanupFailed = true;
    if (fixtureModule) {
      try {
        await withP13InvitationEnvironment(context.env, () => fixtureModule!.disposeP13InvitationBrowserFixtures(fixtures));
      } catch { cleanupFailed = true; }
    }
    if (proxy) {
      try { await proxy.close(); } catch { cleanupFailed = true; }
    }
  }
  if (cleanupFailed) throw new Error("p1_3_invitation_acceptance_browser_cleanup_failed");
  if (failure) throw failure;
}

export function createLifecycle(mode: "acceptance" | "diagnostic", serviceProbe?: (context: RunContext) => Promise<void>): P13InvitationAcceptanceLifecycle {
  const requestedSuffix = process.env.CUBBY_P13_INVITATION_LIFECYCLE_SUFFIX;
  const suffix = requestedSuffix ?? randomBytes(8).toString("hex");
  if (!/^[a-f0-9]{16}$/.test(suffix)) throw new Error("p1_3_invitation_acceptance_prepare_failed");
  const requestedTemporaryRoot = process.env.CUBBY_P13_INVITATION_TEMPORARY_ROOT;
  const database = `p13_invitation_${suffix}`;
  const context: RunContext = {
    project: `cubby-p1-3-invitation-${suffix}`,
    env: safeEnvironment(`p13_invitation_${suffix}`, database, randomBytes(24).toString("base64url")),
    temporaryRoot: "",
    startupStatusRoot: "",
    copiedPrisma: "",
    migratorPassword: "",
    rolePasswords: Object.freeze({
      cubby_runtime: randomBytes(24).toString("base64url"),
      cubby_auth: randomBytes(24).toString("base64url"),
      cubby_email_delivery: randomBytes(24).toString("base64url"),
      cubby_security_operator: randomBytes(24).toString("base64url"),
      cubby_invitation_runtime: randomBytes(24).toString("base64url"),
      cubby_invitation_expiry_worker: randomBytes(24).toString("base64url"),
      cubby_invitation_maintenance_worker: randomBytes(24).toString("base64url")
    }),
    freshAuthKeys: [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")],
    deliveryKeys: [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")],
    throttleKey: randomBytes(32).toString("base64url"),
    disposableImageTags: []
  };
  context.migratorPassword = context.env.CUBBY_BROWSER_OPERATION_ACCEPTANCE_PASSWORD!;
  mkdirSync(workerRuntime, { recursive: true });
  context.temporaryRoot = requestedTemporaryRoot
    ? resolve(requestedTemporaryRoot)
    : resolve(workerRuntime, `cubby-p1-3-invitation-${suffix}`);
  if (dirname(context.temporaryRoot) !== resolve(workerRuntime) || existsSync(context.temporaryRoot)) {
    throw new Error("p1_3_invitation_acceptance_prepare_failed");
  }
  context.startupStatusRoot = resolve(context.temporaryRoot, "startup-status");
  context.copiedPrisma = resolve(context.temporaryRoot, "prisma");
  process.stdout.write(`p1_3_invitation_project=${context.project}\n`);
  process.stdout.write(`p1_3_invitation_temporary_root=${context.temporaryRoot}\n`);
  // Compose evaluates every service's required inputs before it starts only PostgreSQL.
  // This generated placeholder is replaced with the generated TLS origin before app startup.
  configureP13InvitationBrowserEnvironment(context, database, "https://127.0.0.1:1");
  const compose = ["compose", "--project-name", context.project, "--file", composeFile];

  return {
    async prepare() {
      assertP13InvitationDisposablePreflight(context);
      verifyP13InvitationNormalRuntime();
      mkdirSync(context.startupStatusRoot, { recursive: true });
      copyCurrentPrisma(context.copiedPrisma);
      run("docker", [...compose, "up", "--detach", "--wait", "postgres"], context.env, "p1_3_invitation_acceptance_postgres_start_failed");
      const published = run("docker", [...compose, "port", "postgres", "5432"], context.env, "p1_3_invitation_acceptance_port_probe_failed");
      if (!/^127\.0\.0\.1:\d+$/.test(published)) throw new Error("p1_3_invitation_acceptance_loopback_publication_invalid");
      context.databaseUrl = postgresUrl(context.env.CUBBY_BROWSER_OPERATION_ACCEPTANCE_USER!, context.migratorPassword, published, database);
      const runtimeUrl = roleUrl(context.databaseUrl, "cubby_runtime", context.rolePasswords.cubby_runtime);
      const authUrl = roleUrl(context.databaseUrl, "cubby_auth", context.rolePasswords.cubby_auth);
      const deliveryUrl = roleUrl(context.databaseUrl, "cubby_email_delivery", context.rolePasswords.cubby_email_delivery);
      run("node", [resolve(root, "scripts/provision-security-runtime-role.mjs")], {
        ...context.env,
        DATABASE_URL: context.databaseUrl,
        CUBBY_RUNTIME_DATABASE_URL: runtimeUrl,
        CUBBY_AUTH_DATABASE_URL: authUrl,
        CUBBY_EMAIL_DELIVERY_DATABASE_URL: deliveryUrl,
        CUBBY_SECURITY_OPERATOR_DB_PASSWORD: context.rolePasswords.cubby_security_operator
      }, "p1_3_invitation_acceptance_global_role_provision_failed");
      run("node", [resolve(root, "scripts/provision-invitation-runtime-roles.mjs")], {
        ...context.env,
        DATABASE_URL: context.databaseUrl,
        INVITATION_DATABASE_URL: roleUrl(context.databaseUrl, "cubby_invitation_runtime", context.rolePasswords.cubby_invitation_runtime),
        INVITATION_EXPIRY_DATABASE_URL: roleUrl(context.databaseUrl, "cubby_invitation_expiry_worker", context.rolePasswords.cubby_invitation_expiry_worker),
        INVITATION_MAINTENANCE_DATABASE_URL: roleUrl(context.databaseUrl, "cubby_invitation_maintenance_worker", context.rolePasswords.cubby_invitation_maintenance_worker)
      }, "p1_3_invitation_acceptance_invitation_role_provision_failed");
    },
    async migrate() {
      if (!context.databaseUrl) throw new Error("p1_3_invitation_acceptance_database_url_unavailable");
      run("node", [resolve(root, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", resolve(context.copiedPrisma, "schema.prisma")], { ...context.env, DATABASE_URL: context.databaseUrl }, "p1_3_invitation_acceptance_migration_failed", context.temporaryRoot);
      const owner = { ...context.env, DATABASE_URL: context.databaseUrl };
      run("node", [resolve(root, "scripts/provision-fresh-auth-attestation-keys.mjs")], { ...owner, CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${context.freshAuthKeys[0]}`, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1" }, "p1_3_invitation_acceptance_fresh_auth_key_provision_failed");
      run("node", [resolve(root, "scripts/provision-fresh-auth-attestation-keys.mjs")], { ...owner, CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${context.freshAuthKeys[0]},2:${context.freshAuthKeys[1]}`, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "2" }, "p1_3_invitation_acceptance_fresh_auth_overlap_failed");
      run("node", [resolve(root, "scripts/provision-email-delivery-keys.mjs")], { ...owner, CUBBY_EMAIL_DELIVERY_KEYRING: `1:${context.deliveryKeys[0]}`, CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "1" }, "p1_3_invitation_acceptance_delivery_key_provision_failed");
      run("node", [resolve(root, "scripts/provision-email-delivery-keys.mjs")], { ...owner, CUBBY_EMAIL_DELIVERY_KEYRING: `1:${context.deliveryKeys[0]},2:${context.deliveryKeys[1]}`, CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "2" }, "p1_3_invitation_acceptance_delivery_key_overlap_failed");
      run("node", [resolve(root, "scripts/provision-global-security-throttle-key.mjs")], { ...owner, CUBBY_THROTTLE_KEY: context.throttleKey }, "p1_3_invitation_acceptance_throttle_key_provision_failed");
    },
    async verifyDatabase() {
      const manualCreateIdentity = run("docker", psqlArguments(context, p13InvitationManualCreateCatalogStatement()), context.env, "p1_3_invitation_acceptance_manual_create_catalog_query_failed");
      if (manualCreateIdentity !== "1") throw new Error("p1_3_invitation_acceptance_manual_create_catalog_identity_invalid");
      for (const check of p13InvitationPermissionCatalogChecks()) {
        const result = run("docker", psqlArguments(context, check.statement), context.env, check.failureCode);
        if (result !== check.expected) throw new Error(check.failureCode);
      }
      const exactRoleCount = run("docker", psqlArguments(context, "SELECT count(*) FROM pg_roles WHERE rolname IN ('cubby_runtime','cubby_auth','cubby_email_delivery','cubby_security_operator','cubby_invitation_runtime','cubby_invitation_expiry_worker','cubby_invitation_maintenance_worker') AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolinherit;"), context.env, "p1_3_invitation_acceptance_role_query_failed");
      if (exactRoleCount !== "7") throw new Error("p1_3_invitation_acceptance_role_topology_invalid");
      const grants = run("docker", psqlArguments(context, "SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='invitation_protocol' AND has_function_privilege('cubby_invitation_runtime',p.oid,'EXECUTE')) || '|' || (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='invitation_protocol' AND p.proname=ANY(ARRAY['claim_invitation_presentation_v2','close_invitation_presentation_v2','reserve_manual_invite_create_v2','submit_manual_invite_create_v2','status_manual_invite_create_v2','abandon_manual_invite_create_v2','reserve_manual_invite_replace_v2','submit_manual_invite_replace_v2','status_manual_invite_replace_v2','abandon_manual_invite_replace_v2','reserve_invitation_credential_setup_v2','submit_invitation_credential_setup_v2','status_invitation_credential_setup_v2','abandon_invitation_credential_setup_v2','reserve_invitation_recovery_enrollment_v2','authorize_invitation_recovery_enrollment_fresh_auth_v2','bind_invitation_recovery_enrollment_fresh_auth_v2','submit_invitation_recovery_enrollment_v2','status_invitation_recovery_enrollment_v2','abandon_invitation_recovery_enrollment_v2','reserve_invitation_recovery_rehearsal_v2','submit_invitation_recovery_rehearsal_v2','status_invitation_recovery_rehearsal_v2','abandon_invitation_recovery_rehearsal_v2','bind_post_signin_invitation_claim_v2','issue_invitation_review_v2','reserve_invitation_acceptance_v2','submit_invitation_acceptance_v2','status_invitation_acceptance_v2','abandon_invitation_acceptance_v2','revoke_invitation_v2','revoke_all_invitations_v2','classify_invitation_setup_corridor_v2']));"), context.env, "p1_3_invitation_acceptance_grant_query_failed");
      if (grants !== "33|33") throw new Error("p1_3_invitation_acceptance_runtime_grants_invalid");
      // The thirty-fifth reviewed signature is the private audit helper. Its
      // effects are reached only through terminal guarded transitions; direct
      // Prisma/runtime execution must remain impossible.
      const privateAuditGrant = run("docker", psqlArguments(context, "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='invitation_protocol' AND p.proname='write_invitation_audit_v2' AND has_function_privilege('cubby_invitation_runtime',p.oid,'EXECUTE');"), context.env, "p1_3_invitation_acceptance_private_audit_grant_query_failed");
      if (privateAuditGrant !== "0") throw new Error("p1_3_invitation_acceptance_private_audit_exposed");
      expectRejected("docker", psqlArguments(context, "INSERT INTO invitation_protocol.\"InvitationOperationIdentity\" (\"id\") VALUES ('00000000-0000-4000-8000-000000000001');", "cubby_invitation_runtime"), context.env, "p1_3_invitation_acceptance_direct_dml_not_denied", "permission denied");
      expectRejected("docker", psqlArguments(context, "SELECT * FROM public.\"FreshAuthAttestationKey\";", "cubby_invitation_runtime"), context.env, "p1_3_invitation_acceptance_key_read_not_denied", "permission denied");
      const overlap = run("docker", psqlArguments(context, "SELECT (SELECT count(*) FROM public.\"FreshAuthAttestationKey\" WHERE \"active\") || '|' || (SELECT count(*) FROM public.\"EmailDeliveryEncryptionKey\" WHERE \"activeWrite\");"), context.env, "p1_3_invitation_acceptance_key_lifecycle_query_failed");
      if (overlap !== "2|1") throw new Error("p1_3_invitation_acceptance_key_lifecycle_invalid");
      const deferredDeletion = run("docker", psqlArguments(context, "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','invitation_protocol') AND c.relname=ANY(ARRAY['InvitationHouseholdDeleteAuthorization','invitation_household_delete_authorization'])) || '|' || (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='invitation_protocol' AND p.proname=ANY(ARRAY['delete_household_with_invitation_containment_v2','issue_invitation_household_delete_authorization_v2'])) || '|' || (SELECT count(*) FROM pg_roles WHERE rolname='cubby_household_delete_runtime') || '|' || (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='invitation_protocol' AND t.typname='invitation_audit_action' AND e.enumlabel='invitation.household.contain') || '|' || (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='invitation_protocol' AND has_function_privilege('cubby_invitation_runtime',p.oid,'EXECUTE') AND p.proname IN ('delete_household_with_invitation_containment_v2','issue_invitation_household_delete_authorization_v2')) || '|' || has_table_privilege('cubby_invitation_runtime','public.\"Household\"','DELETE') || '|' || has_table_privilege('cubby_invitation_expiry_worker','public.\"Household\"','DELETE') || '|' || has_table_privilege('cubby_invitation_maintenance_worker','public.\"Household\"','DELETE');"), context.env, "p1_3_invitation_acceptance_deferred_deletion_catalog_query_failed");
      if (deferredDeletion !== "0|0|0|0|0|false|false|false") throw new Error("p1_3_invitation_acceptance_deferred_deletion_boundary_invalid");
    },
    async verifySmtp() {
      const keyPath = resolve(context.temporaryRoot, "smtp-key.pem");
      const certificatePath = resolve(context.temporaryRoot, "smtp-cert.pem");
      run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certificatePath, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], context.env, "p1_3_invitation_acceptance_smtp_certificate_failed");
      const username = `smtp-${randomBytes(8).toString("hex")}`;
      const password = randomBytes(24).toString("base64url");
      const recipient = `smtp-${randomBytes(8).toString("hex")}@acceptance.invalid`;
      const smtp = await startAuthenticatedTlsSmtp({ key: readFileSync(keyPath), cert: readFileSync(certificatePath), username, password, recipient });
      try {
        const adapter = createSmtpEmailDeliveryAdapter({ SMTP_HOST: "127.0.0.1", SMTP_PORT: smtp.port.toString(), SMTP_USER: username, SMTP_PASSWORD: password, EMAIL_FROM: "Cubby <noreply@acceptance.invalid>", SMTP_CA_CERT: readFileSync(certificatePath, "utf8"), SMTP_SECURE: "true" });
        const receipt = await adapter.send({ recipient, subject: "Acceptance delivery", text: "No invitation token is carried by this message.", messageId: `<${randomBytes(12).toString("hex")}@acceptance.invalid>` });
        if (!smtp.authenticated || receipt.responseCode !== 250 || receipt.accepted.length !== 1 || receipt.accepted[0] !== recipient || smtp.accepted.length !== 1 || smtp.accepted[0] !== recipient) {
          throw new Error("p1_3_invitation_acceptance_tls_smtp_receipt_invalid");
        }
      } finally {
        await smtp.close();
      }
    },
    async verifyInvitationRuntime() {
      if (!context.databaseUrl) throw new Error("p1_3_invitation_acceptance_database_url_unavailable");
      context.env = {
        ...context.env,
        // The probe owner is restricted to generated fixture setup and postcondition reads.
        // Protocol mutations remain on the dedicated invitation procedure clients below.
        FIXTURE_DATABASE_URL: context.databaseUrl,
        DATABASE_URL: roleUrl(context.databaseUrl, "cubby_runtime", context.rolePasswords.cubby_runtime),
        AUTH_DATABASE_URL: roleUrl(context.databaseUrl, "cubby_auth", context.rolePasswords.cubby_auth),
        INVITATION_DATABASE_URL: roleUrl(context.databaseUrl, "cubby_invitation_runtime", context.rolePasswords.cubby_invitation_runtime),
        INVITATION_EXPIRY_DATABASE_URL: roleUrl(context.databaseUrl, "cubby_invitation_expiry_worker", context.rolePasswords.cubby_invitation_expiry_worker),
        INVITATION_MAINTENANCE_DATABASE_URL: roleUrl(context.databaseUrl, "cubby_invitation_maintenance_worker", context.rolePasswords.cubby_invitation_maintenance_worker),
        CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${context.freshAuthKeys[0]},2:${context.freshAuthKeys[1]}`,
        CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "2",
        BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
        BETTER_AUTH_URL: "https://acceptance.invalid",
        TRUSTED_ORIGINS: "https://acceptance.invalid",
      };
      await (serviceProbe ?? runRuntimeProbe)(context);
    },
    async verifyBrowserCdp() {
      if (!context.databaseUrl) throw new Error("p1_3_invitation_acceptance_browser_fixture_failed");
      await runP13InvitationBrowserCdp(context, compose, database, mode);
    },
    async cleanup() {
      const down = spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans", "--rmi", "local"], { cwd: root, env: context.env, stdio: "ignore", timeout: 120_000 });
      let cleanupCommandFailed = Boolean(down.error) || down.status !== 0;
      for (const tag of context.disposableImageTags) {
        const removal = spawnSync("docker", ["image", "rm", "--force", tag], { cwd: root, env: context.env, stdio: "ignore", timeout: 120_000 });
        cleanupCommandFailed ||= Boolean(removal.error) || removal.status !== 0;
      }
      rmSync(context.temporaryRoot, { recursive: true, force: true });
      if (cleanupCommandFailed || p13InvitationDisposablePreflightFailureCode({
        temporaryRootPresent: existsSync(context.temporaryRoot),
        containersPresent: Boolean(resourceCount(context, "ps")),
        volumesPresent: Boolean(resourceCount(context, "volume")),
        networksPresent: Boolean(resourceCount(context, "network")),
        imagesPresent: Boolean(resourceCount(context, "image"))
      })) {
        throw new Error("p1_3_invitation_acceptance_cleanup_failed");
      }
      verifyP13InvitationNormalRuntime();
    }
  };
}

export async function runP13InvitationAcceptance(mode: "acceptance" | "diagnostic" = "diagnostic") {
  if (mode !== "acceptance" && mode !== "diagnostic") throw new Error("p1_3_invitation_acceptance_failed");
  await executeP13InvitationAcceptance(createLifecycle(mode), () => process.stdout.write(mode === "acceptance"
    ? "p1_3_invitation_acceptance_complete\n"
    : "p1_3_invitation_acceptance_browser_instrumentation_and_route_confirmed\n"));
}

if (process.env.VITEST !== "true") {
  runP13InvitationAcceptance("acceptance").catch((error) => {
    process.stderr.write(`${p13InvitationAcceptanceFailureCode(error)}\n`);
    process.exitCode = 1;
  });
}
