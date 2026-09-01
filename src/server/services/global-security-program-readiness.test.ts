import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readiness = JSON.parse(readFileSync(fileURLToPath(new URL("../../../docs/design/p1-3-global-security-program-readiness.json", import.meta.url)), "utf8"));

describe("P1-3 complete-program local readiness", () => {
  it("preserves accepted substrate evidence while activating DEC-PROD-408 without authorizing publication or runtime use", () => {
    expect(readiness).toMatchObject({
      schemaVersion: 1,
      program: "p1_3_global_credential_session_security",
      state: "existing_user_activation_review_candidate_unreleased",
      authority: "DEC-PROD-408_replacement_charter",
      baseHead: "9b699207892d392073bee9f97f7997d0bda5b0ab"
    });
    expect(readiness.postRecoveryActivation).toEqual({
      decision: "DEC-PROD-408",
      boundary: "existing_user_password_recovery_email_all_or_none",
      initialCredentialSignup: "denied_until_separate_invitation_onboarding_program",
      candidateState: "verification_complete_review_candidate",
      charter: "hermes-control/reports/2026-08-31-p1-3-existing-user-security-activation-replacement-charter.md"
    });
    expect(readiness.phases).toEqual([
      "phase1_persistence",
      "phase2_session_authorization",
      "phase3_fresh_auth",
      "phase4_password_transition",
      "phase5_offline_recovery",
      "phase6_verified_email_change",
      "phase7_private_session_security",
      "phase8_private_history_throttling",
      "phase9_integrated_acceptance"
    ].map((id) => ({ id, state: "accepted_local_source" })));
    expect(readiness.integratedGates.map((gate: { id: string; state: string }) => `${gate.id}:${gate.state}`)).toEqual([
      "protocol_and_persistence:verified",
      "framework_route_cutover:verified",
      "credential_recovery_email_session_transitions:verified",
      "private_history_throttling_retention:verified",
      "disposable_postgresql:verified",
      "real_chrome:verified",
      "typecheck_lint_build_registry_diff:verified",
      "serial_full_suite:verified_with_protected_exception",
      "independent_phase_reviews:verified"
    ]);
    expect(readiness.protectedException).toEqual({
      path: "src/server/services/browser-operation-household-foundation-migration.test.ts",
      reason: "unrelated_crlf_sensitive_literal_assertion",
      disposition: "untouched_and_reported_separately"
    });
    expect(readiness.forbiddenActions).toEqual([
      "push",
      "pull_request",
      "merge",
      "publish",
      "deploy",
      "normal_runtime_database",
      "live_credential_or_recovery_flow",
      "secret_access",
      "branch_or_worktree_cleanup"
    ]);
  });
});
