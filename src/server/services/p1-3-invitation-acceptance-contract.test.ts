import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  p13InvitationAcceptanceFailureCode,
  p13InvitationAppHealthFailureCode,
  p13InvitationFrameworkErrorCode,
  p13InvitationCompiledRouteFailureCode,
  p13InvitationInstrumentationStageFailureCode,
  p13InvitationRuntimeProbeCommand,
  p13InvitationRuntimeProbeOutputCode,
  p13InvitationManualCreateCatalogStatement,
  p13InvitationPermissionCatalogChecks,
  p13InvitationDisposablePreflightFailureCode,
  p13InvitationResourceArguments,
  executeP13InvitationAcceptance,
  type P13InvitationAcceptanceLifecycle
} from "../../../scripts/p1-3-invitation.acceptance-rehearsal";
import { manualDiagnosticSqlCode, validateManualManagementAcceptance } from "../../../scripts/p1-3-invitation.runtime-probe-contract";
import { runManualManagementDiagnostic, runtimeProbeFailureCode } from "../../../scripts/p1-3-invitation.runtime-probe";

describe("invitation acceptance harness", () => {
  it("maps compiled-app health statuses to fixed non-content-bearing categories", () => {
    expect(p13InvitationAppHealthFailureCode(undefined)).toBe("p1_3_invitation_acceptance_browser_app_health_unreachable");
    expect(p13InvitationAppHealthFailureCode(503)).toBe("p1_3_invitation_acceptance_browser_app_health_unavailable");
    expect(p13InvitationAppHealthFailureCode(204)).toBe("p1_3_invitation_acceptance_browser_app_health_verifier_scope_confirmed");
    expect(p13InvitationAppHealthFailureCode(500)).toBe("p1_3_invitation_acceptance_browser_app_health_route_error");
    expect(p13InvitationAppHealthFailureCode(502)).toBe("p1_3_invitation_acceptance_browser_tls_proxy_upstream_error");
    expect(p13InvitationAppHealthFailureCode(404)).toBe("p1_3_invitation_acceptance_browser_app_health_client_error");
    expect(p13InvitationAppHealthFailureCode(302)).toBe("p1_3_invitation_acceptance_browser_app_health_redirect");
    expect(p13InvitationAppHealthFailureCode(418)).toBe("p1_3_invitation_acceptance_browser_app_health_status_invalid");
    expect(p13InvitationAcceptanceFailureCode(
      new Error("p1_3_invitation_acceptance_browser_route_sentinel_dispatch_failed")
    )).toBe("p1_3_invitation_acceptance_browser_route_sentinel_dispatch_failed");
  });

  it("classifies only exact module/handler markers and fixed HTTP status", () => {
    expect(p13InvitationCompiledRouteFailureCode(204, "evaluated", "entered"))
      .toBe("p1_3_invitation_acceptance_browser_route_entry_and_response_confirmed");
    expect(p13InvitationCompiledRouteFailureCode(500, "evaluated", "entered"))
      .toBe("p1_3_invitation_acceptance_browser_route_response_dispatch_failed");
    expect(p13InvitationCompiledRouteFailureCode(500, "evaluated", "absent"))
      .toBe("p1_3_invitation_acceptance_browser_route_handler_not_entered");
    expect(p13InvitationCompiledRouteFailureCode(500, "absent", "absent"))
      .toBe("p1_3_invitation_acceptance_browser_route_module_not_evaluated");
    expect(p13InvitationCompiledRouteFailureCode(500, "absent", "entered"))
      .toBe("p1_3_invitation_acceptance_browser_route_marker_state_invalid");
    expect(p13InvitationCompiledRouteFailureCode(500, "invalid", "absent"))
      .toBe("p1_3_invitation_acceptance_browser_route_marker_state_invalid");
  });

  it("classifies only exact instrumentation stages and fixed HTTP status", () => {
    expect(p13InvitationInstrumentationStageFailureCode(500, "absent"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_builtin_probe_failed");
    expect(p13InvitationInstrumentationStageFailureCode(500, "node_builtin_ready"))
      .toBe("p1_3_invitation_acceptance_browser_bootstrap_exec_not_selected");
    expect(p13InvitationInstrumentationStageFailureCode(500, "bootstrap_exec_selected"))
      .toBe("p1_3_invitation_acceptance_browser_preload_file_not_loaded");
    expect(p13InvitationInstrumentationStageFailureCode(500, "preload_file_loaded"))
      .toBe("p1_3_invitation_acceptance_browser_preload_guards_not_confirmed");
    expect(p13InvitationInstrumentationStageFailureCode(500, "preload_guards_confirmed"))
      .toBe("p1_3_invitation_acceptance_browser_standalone_server_module_not_entered");
    expect(p13InvitationInstrumentationStageFailureCode(500, "standalone_server_module_entered"))
      .toBe("p1_3_invitation_acceptance_browser_next_package_not_loaded");
    expect(p13InvitationInstrumentationStageFailureCode(500, "next_package_loaded"))
      .toBe("p1_3_invitation_acceptance_browser_start_server_module_not_loaded");
    expect(p13InvitationInstrumentationStageFailureCode(500, "start_server_module_loaded"))
      .toBe("p1_3_invitation_acceptance_browser_start_server_not_invoked");
    expect(p13InvitationInstrumentationStageFailureCode(500, "start_server_invoked"))
      .toBe("p1_3_invitation_acceptance_browser_next_server_module_not_loaded");
    expect(p13InvitationInstrumentationStageFailureCode(500, "next_server_module_loaded"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_module_not_requested");
    expect(p13InvitationInstrumentationStageFailureCode(500, "instrumentation_module_load_requested"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_module_not_evaluated");
    expect(p13InvitationInstrumentationStageFailureCode(500, "module_evaluated"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_register_not_entered");
    expect(p13InvitationInstrumentationStageFailureCode(500, "register_entered"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_module_load_failed");
    expect(p13InvitationInstrumentationStageFailureCode(500, "modules_loaded"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_automated_backup_start_failed");
    expect(p13InvitationInstrumentationStageFailureCode(500, "automated_backup_started"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_integrity_start_failed");
    expect(p13InvitationInstrumentationStageFailureCode(500, "integrity_started"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_sprout_retention_start_failed");
    expect(p13InvitationInstrumentationStageFailureCode(500, "sprout_retention_started"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_browser_retention_start_failed");
    expect(p13InvitationInstrumentationStageFailureCode(500, "browser_operation_retention_started"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_email_delivery_start_failed");
    expect(p13InvitationInstrumentationStageFailureCode(500, "email_delivery_started"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_email_change_start_failed");
    expect(p13InvitationInstrumentationStageFailureCode(500, "email_change_lifecycle_started"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_completed_route_failed");
    expect(p13InvitationInstrumentationStageFailureCode(204, "email_change_lifecycle_started"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_and_route_confirmed");
    expect(p13InvitationInstrumentationStageFailureCode(500, "invalid"))
      .toBe("p1_3_invitation_acceptance_browser_instrumentation_marker_invalid");
  });

  it("classifies disposable framework output into one fixed predeclared identity", () => {
    expect(p13InvitationFrameworkErrorCode("private Cannot find module 'private' private"))
      .toBe("p1_3_invitation_acceptance_browser_framework_module_resolution_failed");
    expect(p13InvitationFrameworkErrorCode("private ReferenceError private"))
      .toBe("p1_3_invitation_acceptance_browser_framework_reference_error");
    expect(p13InvitationFrameworkErrorCode("private TypeError private"))
      .toBe("p1_3_invitation_acceptance_browser_framework_type_error");
    expect(p13InvitationFrameworkErrorCode("private SyntaxError private"))
      .toBe("p1_3_invitation_acceptance_browser_framework_syntax_error");
    expect(p13InvitationFrameworkErrorCode("private Invariant: private"))
      .toBe("p1_3_invitation_acceptance_browser_framework_invariant_error");
    expect(p13InvitationFrameworkErrorCode("private"))
      .toBe("p1_3_invitation_acceptance_browser_framework_unclassified");
  });

  it("classifies SQLSTATE 42883 operator and cast failures without retaining database text", () => {
    expect(manualDiagnosticSqlCode("create_reserve", { meta: { code: "42883", message: "ERROR: operator does not exist: private" } }))
      .toBe("p1_3_invitation_acceptance_check_create_reserve_sql_42883_operator_failed");
    expect(manualDiagnosticSqlCode("create_reserve", { meta: { code: "42883", message: "ERROR: cannot cast private" } }))
      .toBe("p1_3_invitation_acceptance_check_create_reserve_sql_42883_cast_failed");
    expect(manualDiagnosticSqlCode("create_reserve", { meta: { code: "42883", message: "private" } }))
      .toBe("p1_3_invitation_acceptance_check_create_reserve_sql_42883_failed");
    expect(manualDiagnosticSqlCode("create_reserve", Object.assign(new Error("operator does not exist: private"), { meta: { code: "42883" } })))
      .toBe("p1_3_invitation_acceptance_check_create_reserve_sql_42883_operator_failed");
  });

  it("classifies SQLSTATE 42501 only into authorized permission categories", () => {
    const examples = new Map([
      ["permission denied for schema private", "schema_usage"],
      ["permission denied for function private", "function_execute"],
      ["permission denied for relation private", "relation"],
      ["permission denied for sequence private", "sequence"],
      ["new row violates row-level security policy", "row_security"],
      ["must be owner of private", "ownership"],
      ["permission denied to set role private", "role_boundary"],
    ]);
    for (const [message, category] of examples) {
      expect(manualDiagnosticSqlCode("create_reserve", { meta: { code: "42501", message } }))
        .toBe(`p1_3_invitation_acceptance_check_create_reserve_sql_42501_${category}_failed`);
    }
    expect(manualDiagnosticSqlCode("create_reserve", { meta: { code: "42501", message: "private" } }))
      .toBe("p1_3_invitation_acceptance_check_create_reserve_sql_42501_failed");
  });

  it("classifies SQLSTATE P0001 only by migration-defined protocol identity", () => {
    const examples = new Map([
      ["ERROR: invitation_submit_invalid", "submit_invalid"],
      ["ERROR: invitation_operation_conflict", "operation_conflict"],
      ["ERROR: invitation_carrier_invalid", "carrier_invalid"],
      ["ERROR: invitation_attestation_mac_invalid", "attestation_mac_invalid"],
      ["ERROR: invitation_issuer_forbidden", "issuer_forbidden"],
      ["ERROR: invitation_terminal_result_invalid", "terminal_result_invalid"],
      ["ERROR: invitation_audit_projection_invalid", "audit_projection_invalid"],
      ["ERROR: invitation_operation_peer_occupancy_invalid", "operation_peer_occupancy_invalid"],
      ["ERROR: invitation_presentation_occupancy_invalid", "presentation_occupancy_invalid"],
      ["ERROR: invitation_operation_occupancy_invalid", "operation_occupancy_invalid"],
      ["ERROR: invitation_revoke_unavailable", "revoke_unavailable"],
    ]);
    for (const [message, identity] of examples) {
      expect(manualDiagnosticSqlCode("create_submit", { meta: { code: "P0001", message } }))
        .toBe(`p1_3_invitation_acceptance_check_create_submit_sql_p0001_${identity}_failed`);
    }
    expect(manualDiagnosticSqlCode("create_submit", {
      meta: { code: "P0001", message: "CONTEXT: PL/pgSQL function invitation_protocol.submit_manual_invite_create_v2" }
    })).toBe("p1_3_invitation_acceptance_check_create_submit_sql_p0001_submit_entry_failed");
    expect(manualDiagnosticSqlCode("create_submit", { meta: { code: "P0001", message: "private" } }))
      .toBe("p1_3_invitation_acceptance_check_create_submit_sql_p0001_failed");
    expect(manualDiagnosticSqlCode("single_revoke", new Error("ERROR: invitation_presentation_occupancy_invalid")))
      .toBe("p1_3_invitation_acceptance_check_single_revoke_sql_p0001_presentation_occupancy_invalid_failed");
    expect(manualDiagnosticSqlCode("single_revoke", new Error("private diagnostic"))).toBeNull();
  });

  it("preserves only fixed SQLSTATE identities for row-lock execution failures", () => {
    expect(manualDiagnosticSqlCode("single_revoke", { meta: { code: "0A000", message: "private" } }))
      .toBe("p1_3_invitation_acceptance_check_single_revoke_sql_0a000_failed");
    expect(manualDiagnosticSqlCode("single_revoke", { meta: { code: "55006", message: "private" } }))
      .toBe("p1_3_invitation_acceptance_check_single_revoke_sql_55006_failed");
  });

  it("preserves bounded revoke-stage attribution with or without structured SQLSTATE metadata", () => {
    const marker = "invitation_single_revoke_stage_deferred_finalization_failed";
    expect(manualDiagnosticSqlCode("single_revoke", { meta: { code: "P0001", message: marker } }))
      .toBe("p1_3_invitation_acceptance_check_single_revoke_sql_p0001_stage_deferred_finalization_failed");
    expect(manualDiagnosticSqlCode("single_revoke", new Error(marker)))
      .toBe("p1_3_invitation_acceptance_check_single_revoke_stage_deferred_finalization_failed");
    expect(manualDiagnosticSqlCode("single_revoke", new Error("private diagnostic"))).toBeNull();
    expect(manualDiagnosticSqlCode("single_revoke", new Error("invitation_single_revoke_stage_claim_lock_failed")))
      .toBe("p1_3_invitation_acceptance_check_single_revoke_stage_claim_lock_failed");
    expect(manualDiagnosticSqlCode("single_revoke", { meta: { code: "42804", message: "invitation_single_revoke_stage_claim_tombstone_failed" } }))
      .toBe("p1_3_invitation_acceptance_check_single_revoke_sql_42804_stage_claim_tombstone_failed");
  });

  it("checks the exact manual-create catalog signature before runtime execution", () => {
    const statement = p13InvitationManualCreateCatalogStatement();
    expect(statement).toContain("to_regprocedure");
    expect(statement).toContain('reserve_manual_invite_create_v2(uuid,text,public."HouseholdRole",integer,text,bytea,invitation_protocol.invitation_request_attestation)');
  });

  it("uses fixed-output catalog checks for every authorized SQLSTATE 42501 category", () => {
    const checks = p13InvitationPermissionCatalogChecks();
    expect(checks.map(({ category }) => category)).toEqual([
      "schema_usage", "function_execute", "relation", "sequence", "row_security", "ownership", "role_boundary", "established_role_compatibility"
    ]);
    for (const check of checks) {
      expect(check.statement).not.toMatch(/SELECT \*/i);
      expect(check.statement).not.toContain("invitation_protocol_owner_NOLOGIN'");
      expect(check.failureCode).toBe(`p1_3_invitation_acceptance_permission_${check.category}_invalid`);
    }
    expect(checks.find(({ category }) => category === "function_execute")?.statement).toContain("public.gen_random_bytes(integer)");
    expect(checks.find(({ category }) => category === "relation")?.statement).toContain('public."Session"');
    expect(checks.find(({ category }) => category === "established_role_compatibility")?.statement).toContain("cubby_auth");
  });

  it("preserves only allowlisted SQLSTATE metadata at the checkpoint boundary", async () => {
    const failure = Object.assign(new Error("secret raw SQL payload"), { meta: { code: "42883", message: "function write_invitation_binding_v2(private)" } });
    const error = await runManualManagementDiagnostic(async (checkpoint) => {
      checkpoint("create_reserve");
      throw failure;
    }).catch((value: unknown) => value);
    const code = "p1_3_invitation_acceptance_check_create_reserve_sql_42883_binding_failed";
    expect(runtimeProbeFailureCode(error)).toBe(code);
    expect(p13InvitationRuntimeProbeOutputCode(`private\n${code}\nprivate`)).toBe(code);
  });
  it("checks stopped containers and exact project-scoped containers, volumes, networks, and images", () => {
    expect(p13InvitationResourceArguments("cubby-p1-3-invitation-test", "ps")).toEqual([
      "ps", "--all", "--quiet", "--filter", "label=com.docker.compose.project=cubby-p1-3-invitation-test"
    ]);
    expect(p13InvitationResourceArguments("cubby-p1-3-invitation-test", "volume")).toEqual([
      "volume", "ls", "--quiet", "--filter", "label=com.docker.compose.project=cubby-p1-3-invitation-test"
    ]);
    expect(p13InvitationResourceArguments("cubby-p1-3-invitation-test", "network")).toEqual([
      "network", "ls", "--quiet", "--filter", "label=com.docker.compose.project=cubby-p1-3-invitation-test"
    ]);
    expect(p13InvitationResourceArguments("cubby-p1-3-invitation-test", "image")).toEqual([
      "image", "ls", "--quiet", "--filter", "label=com.docker.compose.project=cubby-p1-3-invitation-test"
    ]);
  });

  it("refuses a disposable lifecycle before resource creation when its root or any exact label is present", () => {
    expect(p13InvitationDisposablePreflightFailureCode({
      temporaryRootPresent: false, containersPresent: false, volumesPresent: false, networksPresent: false, imagesPresent: false
    })).toBeUndefined();
    for (const contaminated of ["temporaryRootPresent", "containersPresent", "volumesPresent", "networksPresent", "imagesPresent"] as const) {
      expect(p13InvitationDisposablePreflightFailureCode({
        temporaryRootPresent: false, containersPresent: false, volumesPresent: false, networksPresent: false, imagesPresent: false,
        [contaminated]: true
      })).toBe("p1_3_invitation_acceptance_disposable_preflight_failed");
    }
  });
  it("preserves the innermost manual check through the real enclosing boundary and CLI", async () => {
    const expected = "p1_3_invitation_acceptance_runtime_manual_create_submit_failed";
    const lifecycle: P13InvitationAcceptanceLifecycle = {
      async prepare() {}, async migrate() {}, async verifyDatabase() {}, async verifySmtp() {},
      async verifyInvitationRuntime() {
        await runManualManagementDiagnostic(async () => { throw new Error(expected); });
      },
      async verifyBrowserCdp() {},
      async cleanup() {}
    };
    const error = await executeP13InvitationAcceptance(lifecycle).catch((failure: unknown) => failure);
    expect(p13InvitationAcceptanceFailureCode(error)).toBe(expected);
  });

  it("reports a closed checkpoint for arbitrary errors and gives cleanup failure priority", async () => {
    const lifecycle: P13InvitationAcceptanceLifecycle = {
      async prepare() {}, async migrate() {}, async verifyDatabase() {}, async verifySmtp() {},
      async verifyInvitationRuntime() {
        await runManualManagementDiagnostic(async (checkpoint) => {
          checkpoint("create_status");
          throw new Error("private diagnostic must not escape");
        });
      },
      async verifyBrowserCdp() {},
      async cleanup() {}
    };
    const error = await executeP13InvitationAcceptance(lifecycle).catch((failure: unknown) => failure);
    expect(p13InvitationAcceptanceFailureCode(error)).toBe("p1_3_invitation_acceptance_check_create_status_failed");
    lifecycle.cleanup = async () => { throw new Error("private cleanup diagnostic"); };
    await expect(executeP13InvitationAcceptance(lifecycle)).rejects.toThrow("p1_3_invitation_acceptance_cleanup_failed");
  });

  it("preserves only fixed content-free lifecycle phase failures at the output boundary", () => {
    expect(p13InvitationAcceptanceFailureCode(new Error("p1_3_invitation_acceptance_migrate_failed"))).toBe("p1_3_invitation_acceptance_migrate_failed");
    expect(p13InvitationAcceptanceFailureCode(new Error("p1_3_invitation_acceptance_runtime_grants_invalid"))).toBe("p1_3_invitation_acceptance_runtime_grants_invalid");
    expect(p13InvitationAcceptanceFailureCode(new Error("p1_3_invitation_acceptance_runtime_probe_output_invalid"))).toBe("p1_3_invitation_acceptance_runtime_probe_output_invalid");
    expect(p13InvitationAcceptanceFailureCode(new Error("p1_3_invitation_acceptance_global_role_apply_failed"))).toBe("p1_3_invitation_acceptance_global_role_apply_failed");

    expect(p13InvitationAcceptanceFailureCode(new Error("sensitive diagnostic"))).toBe("p1_3_invitation_acceptance_failed");
    // Every fixed lifecycle code must identify its own boundary; collapsing one into the generic
    // result hides which disposable stage failed and wastes an immutable lifecycle debit.
    for (const preserved of [
      "p1_3_invitation_acceptance_database_url_unavailable",
      "p1_3_invitation_acceptance_fresh_auth_key_provision_failed",
      "p1_3_invitation_acceptance_fresh_auth_overlap_failed",
      "p1_3_invitation_acceptance_delivery_key_provision_failed",
      "p1_3_invitation_acceptance_delivery_key_overlap_failed",
      "p1_3_invitation_acceptance_throttle_key_provision_failed",
      "p1_3_invitation_acceptance_resource_probe_failed",
      "p1_3_invitation_acceptance_smtp_certificate_failed",
      "p1_3_invitation_acceptance_smtp_loopback_failed",
      "p1_3_invitation_acceptance_tls_smtp_receipt_invalid"
    ]) expect(p13InvitationAcceptanceFailureCode(new Error(preserved))).toBe(preserved);
  });

  it("launches the runtime probe through the repository-local TSX entry point", () => {
    const command = p13InvitationRuntimeProbeCommand(process.cwd());
    expect(command.executable).toBe(process.execPath);
    expect(command.args).toEqual([
      "--import", "tsx",
      resolve(process.cwd(), "scripts/p1-3-invitation.runtime-probe.ts")
    ]);
  });

  it("preserves a fixed database-check code but redacts arbitrary database failures", async () => {
    const lifecycle = (databaseFailure: Error): P13InvitationAcceptanceLifecycle => ({
      async prepare() {},
      async migrate() {},
      async verifyDatabase() { throw databaseFailure; },
      async verifySmtp() {},
      async verifyInvitationRuntime() {},
      async verifyBrowserCdp() {},
      async cleanup() {}
    });

    await expect(executeP13InvitationAcceptance(lifecycle(new Error("p1_3_invitation_acceptance_runtime_grants_invalid")))).rejects.toThrow("p1_3_invitation_acceptance_runtime_grants_invalid");
    await expect(executeP13InvitationAcceptance(lifecycle(new Error("sensitive diagnostic")))).rejects.toThrow("p1_3_invitation_acceptance_database_failed");
  });

  it("preserves a fixed preparation code while redacting an arbitrary preparation failure", async () => {
    const lifecycle = (prepareFailure: Error): P13InvitationAcceptanceLifecycle => ({
      async prepare() { throw prepareFailure; },
      async migrate() {}, async verifyDatabase() {}, async verifySmtp() {},
      async verifyInvitationRuntime() {}, async verifyBrowserCdp() {}, async cleanup() {}
    });

    await expect(executeP13InvitationAcceptance(lifecycle(new Error("p1_3_invitation_acceptance_prisma_inventory_invalid")))).rejects.toThrow("p1_3_invitation_acceptance_prisma_inventory_invalid");
    await expect(executeP13InvitationAcceptance(lifecycle(new Error("sensitive preparation diagnostic")))).rejects.toThrow("p1_3_invitation_acceptance_prepare_failed");
  });

  it("preserves allowlisted runtime probe checks while redacting arbitrary child output", async () => {
    const lifecycle = (runtimeFailure: Error): P13InvitationAcceptanceLifecycle => ({
      async prepare() {},
      async migrate() {},
      async verifyDatabase() {},
      async verifySmtp() {},
      async verifyInvitationRuntime() { throw runtimeFailure; },
      async verifyBrowserCdp() {},
      async cleanup() {}
    });

    await expect(executeP13InvitationAcceptance(lifecycle(new Error("p1_3_invitation_acceptance_runtime_persistence_invalid")))).rejects.toThrow("p1_3_invitation_acceptance_runtime_persistence_invalid");
    await expect(executeP13InvitationAcceptance(lifecycle(new Error("p1_3_invitation_acceptance_runtime_manual_management_failed")))).rejects.toThrow("p1_3_invitation_acceptance_runtime_manual_management_failed");
    await expect(executeP13InvitationAcceptance(lifecycle(new Error("p1_3_invitation_acceptance_runtime_service_bootstrap_failed")))).rejects.toThrow("p1_3_invitation_acceptance_runtime_service_bootstrap_failed");
    await expect(executeP13InvitationAcceptance(lifecycle(new Error("p1_3_invitation_acceptance_runtime_probe_output_invalid")))).rejects.toThrow("p1_3_invitation_acceptance_runtime_probe_output_invalid");
    await expect(executeP13InvitationAcceptance(lifecycle(new Error("p1_3_invitation_acceptance_runtime_fixture_seed_failed")))).rejects.toThrow("p1_3_invitation_acceptance_runtime_fixture_seed_failed");
    await expect(executeP13InvitationAcceptance(lifecycle(new Error("p1_3_invitation_acceptance_runtime_manual_create_reserve_failed")))).rejects.toThrow("p1_3_invitation_acceptance_runtime_manual_create_reserve_failed");
    await expect(executeP13InvitationAcceptance(lifecycle(new Error("p1_3_invitation_acceptance_runtime_manual_create_submit_failed")))).rejects.toThrow("p1_3_invitation_acceptance_runtime_manual_create_submit_failed");
    await expect(executeP13InvitationAcceptance(lifecycle(new Error("arbitrary child diagnostic")))).rejects.toThrow("p1_3_invitation_acceptance_runtime_failed");
  });

  it("preserves only the fixed compiled-app startup attribution", async () => {
    const lifecycle = (browserFailure: Error): P13InvitationAcceptanceLifecycle => ({
      async prepare() {}, async migrate() {}, async verifyDatabase() {}, async verifySmtp() {},
      async verifyInvitationRuntime() {}, async verifyBrowserCdp() { throw browserFailure; }, async cleanup() {}
    });

    await expect(executeP13InvitationAcceptance(lifecycle(new Error("p1_3_invitation_acceptance_browser_app_migration_connection_failed")))).rejects.toThrow("p1_3_invitation_acceptance_browser_app_migration_connection_failed");
    await expect(executeP13InvitationAcceptance(lifecycle(new Error("arbitrary browser startup diagnostic")))).rejects.toThrow("p1_3_invitation_acceptance_browser_failed");
  });

  it("keeps the non-browser PostgreSQL phase on the real service, worker, corridor, and route carriers", () => {
    const probe = readFileSync(resolve(process.cwd(), "scripts/p1-3-invitation.runtime-probe.ts"), "utf8");
    const runner = readFileSync(resolve(process.cwd(), "scripts/p1-3-invitation.acceptance-rehearsal.ts"), "utf8");

    for (const call of [
      "services.claim", "services.close", "services.manualCreate.reserve", "services.manualCreate.submit", "services.manualCreate.status", "services.manualCreate.abandon",
      "services.manualReplace.reserve", "services.manualReplace.submit", "services.manualReplace.status", "services.manualReplace.abandon",
      "services.bind", "services.review", "services.credential.reserve", "services.credential.submit", "services.credential.status", "services.credential.abandon",
      "services.recoveryEnrollment.reserve", "services.recoveryEnrollment.submit", "services.recoveryEnrollment.status", "services.recoveryEnrollment.abandon",
      "services.rehearsal.reserve", "services.rehearsal.submit", "services.rehearsal.status", "services.rehearsal.abandon",
      "services.acceptance.reserve", "services.acceptance.submit", "services.acceptance.status", "services.acceptance.abandon",
      "services.revoke", "services.revokeAll", "services.expire", "services.compact",
      "classifyInvitationSetupCorridor", "handleInvitationRoute",
    ]) expect(probe).toContain(call);

    expect(runner).toContain("FIXTURE_DATABASE_URL: context.databaseUrl");
    expect(probe).toContain('new PrismaClient({ datasourceUrl: fixtureDatabaseUrl() })');
    expect(probe).toContain("hashPassword");
    expect(runner).toContain("p1_3_invitation_acceptance_private_audit_exposed");
    expect(runner).not.toContain("p1_3_invitation_acceptance_gap_browser_cdp_only");
  });

  it("requires an isolated compiled-app CDP phase after the invitation runtime probe", () => {
    const runner = readFileSync(resolve(process.cwd(), "scripts/p1-3-invitation.acceptance-rehearsal.ts"), "utf8");
    expect(runner).not.toContain("p1_3_invitation_acceptance_gap_browser_cdp_only");
    for (const required of [
      "verifyBrowserCdp", "p1_3_invitation_acceptance_browser_cdp_failed", "COMPOSE_DISABLE_ENV_FILE: \"true\"",
      "compose, \"up\", \"--detach\", \"--wait\", \"app\"", "buildP13InvitationAppImage",
      "--user-data-dir=${profile}", "Fetch.failRequest", "Page.getNavigationHistory",
      "localStorage", "sessionStorage", "historyEntries", "Emulation.setDeviceMetricsOverride",
      "375, 812", "1280, 900", "response_loss", "InvitationWorkflow",
 "p1_3_invitation_acceptance_browser_app_dependencies_build_failed",
 "p1_3_invitation_acceptance_browser_app_builder_build_failed",
 "p1_3_invitation_acceptance_browser_app_runtime_dependencies_prune_failed",
 "p1_3_invitation_acceptance_browser_app_runner_public_failed",
 "p1_3_invitation_acceptance_browser_app_runner_standalone_failed",
 "p1_3_invitation_acceptance_browser_app_runner_static_failed",
 "p1_3_invitation_acceptance_browser_app_runner_runtime_artifacts_failed",
 "p1_3_invitation_acceptance_browser_app_runner_filesystem_failed",
 "p1_3_invitation_acceptance_browser_operation_infrastructure_invalid",
 "p1_3_invitation_acceptance_browser_app_health_unreachable",
 "p1_3_invitation_acceptance_browser_app_health_unavailable",
 "p1_3_invitation_acceptance_browser_app_health_status_invalid"
    ]) expect(runner).toContain(required);
    expect(runner).toContain('configureP13InvitationBrowserEnvironment(context, database, "https://127.0.0.1:1")');
    expect(runner).toContain("resourceCount(context, \"image\")");
  });

  it("emits only the generated disposable project and temporary-root identifiers before lifecycle work", () => {
    const runner = readFileSync(resolve(process.cwd(), "scripts/p1-3-invitation.acceptance-rehearsal.ts"), "utf8");
    expect(runner).toContain('p1_3_invitation_project=${context.project}');
    expect(runner).toContain('p1_3_invitation_temporary_root=${context.temporaryRoot}');
  });

  it("copies the complete fail-closed current migration tree for the isolated app", () => {
    const runner = readFileSync(resolve(process.cwd(), "scripts/p1-3-invitation.acceptance-rehearsal.ts"), "utf8");

    expect(runner).toContain('readdirSync(resolve(root, "prisma", "migrations"), { withFileTypes: true })');
    expect(runner).toContain('/^\\d{14}_[a-z0-9_]+$/');
    expect(runner).not.toContain('git", ["ls-files", "-z", "--", "prisma/schema.prisma", "prisma/migrations"]');
  });

  it("excludes only the known empty pre-protocol migration directory from both synthetic and image inputs", () => {
    const runner = readFileSync(resolve(process.cwd(), "scripts/p1-3-invitation.acceptance-rehearsal.ts"), "utf8");
    const dockerignore = readFileSync(resolve(process.cwd(), ".dockerignore"), "utf8");
    const ignored = "20260904100000_invitation_protocol_v6";

    expect(runner).toContain(`const ignoredEmptyMigrationDirectory = "${ignored}"`);
    expect(dockerignore).toContain(`prisma/migrations/${ignored}/`);
  });

  it("does not leave an unresolved String call in the package-command argument flow", () => {
    const runner = readFileSync(resolve(process.cwd(), "scripts/p1-3-invitation.acceptance-rehearsal.ts"), "utf8");

    expect(runner).not.toMatch(/\bString\(/);
    expect(runner).toContain('(result.stdout ?? "").trim()');
  });

  it("checks the compiled app through the generated loopback TLS origin", () => {
    const runner = readFileSync(resolve(process.cwd(), "scripts/p1-3-invitation.acceptance-rehearsal.ts"), "utf8");

    expect(runner).toContain("rejectUnauthorized: false");
    expect(runner).toContain("waitForP13InvitationAppHealth(context, proxy.origin)");
  });

  it("executes each runtime phase before a single terminal success and tears down in reverse on success", async () => {
    const calls: string[] = [];
    const lifecycle: P13InvitationAcceptanceLifecycle = {
      async prepare() { calls.push("prepare"); },
      async migrate() { calls.push("migrate"); },
      async verifyDatabase() { calls.push("database"); },
      async verifySmtp() { calls.push("smtp"); },
      async verifyInvitationRuntime() { calls.push("invitation"); },
      async verifyBrowserCdp() { calls.push("browser"); },
      async cleanup() { calls.push("cleanup"); }
    };

    await executeP13InvitationAcceptance(lifecycle, (event) => calls.push(event));

    expect(calls).toEqual([
      "prepare", "migrate", "database", "smtp", "invitation", "browser",
      "cleanup", "p1_3_invitation_acceptance_complete"
    ]);
  });

  it("fails closed without a success event and still cleans every acquired resource", async () => {
    const calls: string[] = [];
    const lifecycle: P13InvitationAcceptanceLifecycle = {
      async prepare() { calls.push("prepare"); },
      async migrate() { calls.push("migrate"); throw new Error("opaque"); },
      async verifyDatabase() { calls.push("database"); },
      async verifySmtp() { calls.push("smtp"); },
      async verifyInvitationRuntime() { calls.push("invitation"); },
      async verifyBrowserCdp() { calls.push("browser"); },
      async cleanup() { calls.push("cleanup"); }
    };

    await expect(executeP13InvitationAcceptance(lifecycle, (event) => calls.push(event))).rejects.toThrow("p1_3_invitation_acceptance_migrate_failed");
    expect(calls).toEqual(["prepare", "migrate", "cleanup"]);
    expect(calls).not.toContain("p1_3_invitation_acceptance_complete");
  });

  it("accepts only a fully persisted manual-management lifecycle snapshot", () => {
    expect(() => validateManualManagementAcceptance({
      create: { preparedIdentity: true, preparedBinding: true, preparedPayload: true, inviteCount: 0, terminalResultCount: 0, auditCount: 0 },
      createSubmit: { pendingInviteCount: 1, terminalResultCount: 1, auditCount: 1, rawTokenOnlyInInitialResponse: true, tokenHashLocatesInvite: true, statusDoesNotRediscloseToken: true },
      createReplay: { duplicateInviteCount: 0, unchangedAuditCount: true, changedIntentConflictedWithoutMutation: true },
      replace: { predecessorRevoked: true, successorVersionIncremented: true, successorTokenOnlyInInitialResponse: true, terminalResultCount: 1, auditCount: 1 },
      revoke: { exactTargetTerminalized: true, claimClosed: true, auditCount: 1 },
      revokeAll: { exactPendingTargetsTerminalized: true, claimsClosed: true, auditCount: 1 },
      authorityLoss: { failedClosed: true, noSuccessEffects: true },
      privacy: { rawTokenAbsentFromPersistence: true, rawTokenAbsentFromAuditAndStatus: true, credentiallessExistingUserDenied: true },
      householdDeletion: { absentAndFailClosed: true }
    })).not.toThrow();

    expect(() => validateManualManagementAcceptance({
      create: { preparedIdentity: true, preparedBinding: true, preparedPayload: true, inviteCount: 1, terminalResultCount: 0, auditCount: 0 },
      createSubmit: { pendingInviteCount: 1, terminalResultCount: 1, auditCount: 1, rawTokenOnlyInInitialResponse: true, tokenHashLocatesInvite: true, statusDoesNotRediscloseToken: true },
      createReplay: { duplicateInviteCount: 0, unchangedAuditCount: true, changedIntentConflictedWithoutMutation: true },
      replace: { predecessorRevoked: true, successorVersionIncremented: true, successorTokenOnlyInInitialResponse: true, terminalResultCount: 1, auditCount: 1 },
      revoke: { exactTargetTerminalized: true, claimClosed: true, auditCount: 1 },
      revokeAll: { exactPendingTargetsTerminalized: true, claimsClosed: true, auditCount: 1 },
      authorityLoss: { failedClosed: true, noSuccessEffects: true },
      privacy: { rawTokenAbsentFromPersistence: true, rawTokenAbsentFromAuditAndStatus: true, credentiallessExistingUserDenied: true },
      householdDeletion: { absentAndFailClosed: true }
    })).toThrow("p1_3_invitation_acceptance_runtime_postcondition_create_invite_count_invalid");
    const fixedCode = "p1_3_invitation_acceptance_runtime_postcondition_create_invite_count_invalid";
    expect(runtimeProbeFailureCode(new Error(fixedCode))).toBe(fixedCode);
    expect(p13InvitationRuntimeProbeOutputCode(`private\n${fixedCode}\nprivate`)).toBe(fixedCode);
  });
});
