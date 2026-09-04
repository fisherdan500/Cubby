import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const postgresAcceptancePath = fileURLToPath(new URL("../../../scripts/p1-3-global-security-phase1.acceptance-rehearsal.ts", import.meta.url));
const browserAcceptancePath = fileURLToPath(new URL("../../../scripts/p1-3-email-change-browser.acceptance-rehearsal.ts", import.meta.url));
const remediationMigrationPath = fileURLToPath(new URL("../../../prisma/migrations/20260829210000_global_security_phase8_review_remediation/migration.sql", import.meta.url));
const carrierPath = fileURLToPath(new URL("sign-in-email-throttle.ts", import.meta.url));
const historyComponentPath = fileURLToPath(new URL("../../components/settings/security-history.tsx", import.meta.url));
const readmePath = fileURLToPath(new URL("../../../README.md", import.meta.url));

describe("Phase 8 disposable acceptance contract", () => {
  it("keeps the loopback PostgreSQL rehearsal comprehensive and content-free", () => {
    const acceptance = readFileSync(postgresAcceptancePath, "utf8");

    for (const migration of [
      "20260829120000_global_security_throttle_core",
      "20260829170000_global_security_phase8_carriers",
      "20260829190000_global_security_private_history_reader",
      "20260829200000_global_security_operator_aggregate",
      "20260829210000_global_security_phase8_review_remediation"
    ]) expect(acceptance).toContain(migration);
    for (const marker of [
      "PHASE8_ROLE_AND_EXACT_GRANT_PASS",
      "PHASE8_THROTTLE_SERVICE_AND_PROCEDURE_PASS",
      "PHASE8_RECOVERY_REHEARSAL_RESET_CARDINALITY_PASS",
      "PHASE8_HISTORY_SERVICE_CURSOR_EXPORT_PASS",
      "PHASE8_HISTORY_CASCADE_NEUTRAL_RETENTION_PASS",
      "PHASE8_OPERATOR_PACKAGED_CLI_PASS"
    ]) expect(acceptance).toContain(marker);
    for (const contract of [
      "provision-global-security-throttle-key.mjs",
      "cubby_security_operator",
      "recordGlobalSecurityThrottleFailure",
      "precheckGlobalSecurityThrottle",
      "writeGlobalSecurityEvent",
      "listGlobalSecurityHistory",
      "exportGlobalSecurityHistory",
      "security_history_cursor_invalid",
      "read_global_security_operator_aggregate",
      "security_operator_operation_failed",
      "GlobalSecurityIncident_retention_guard",
      "GlobalSecurityThrottleKey=0"
    ]) expect(acceptance).toContain(contract);
  });

  it("uses the real private-history component against only synthetic safe API responses", () => {
    const acceptance = readFileSync(browserAcceptancePath, "utf8");

    for (const contract of [
      "SecurityHistory",
      "/api/account/security-history",
      "/api/account/security-history/export",
      "P1_3_SECURITY_HISTORY_BROWSER_ACCEPTANCE_PASS",
      "P1_3_SECURITY_HISTORY_BROWSER_ACCEPTANCE_CLEANUP_PASS",
      "history_confirmation_focus_missing",
      "history_cancel_missing",
      "history_download_missing",
      "history_forbidden_browser_surface",
      "198.51.100.71",
      "ForbiddenHistoryUserAgent/1.0",
      "security-history-household",
      "security-history-baby"
    ]) expect(acceptance).toContain(contract);
  });

  it("closes the review blockers for snapshot locking, atomic sign-in evidence, accessibility, and host-only operator execution", () => {
    const migration = readFileSync(remediationMigrationPath, "utf8");
    const carrier = readFileSync(carrierPath, "utf8");
    const history = readFileSync(historyComponentPath, "utf8");
    const readme = readFileSync(readmePath, "utf8");
    const postgresAcceptance = readFileSync(postgresAcceptancePath, "utf8");
    const browserAcceptance = readFileSync(browserAcceptancePath, "utf8");

    expect(migration).toContain('CREATE TRIGGER "00_GlobalSecurityEvent_transition_lock" BEFORE INSERT ON public."GlobalSecurityEvent" FOR EACH STATEMENT');
    expect(migration).toContain('pg_advisory_xact_lock(hashtextextended(\'global-security-transition:v1\', 0))');
    expect(migration).toContain('CREATE TRIGGER "Session_sign_in_succeeded_event" AFTER INSERT ON public."Session" FOR EACH ROW');
    expect(migration).toContain("session_user");
    expect(migration).toContain("sign_in_succeeded");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
    expect(carrier).not.toContain("writeEvent");
    expect(carrier).toContain("security_sign_in_evidence_unavailable");
    expect(history).toContain("exportButtonRef");
    expect(history).toContain("Your security history export is ready.");
    expect(history).toContain("More security history loaded.");
    expect(readme).toContain("docker compose exec -T -e SECURITY_OPERATOR_DATABASE_URL=");
    for (const marker of [
      "PHASE8_EVENT_SEQUENCE_SNAPSHOT_RACE_PASS",
      "PHASE8_CONCURRENT_EXPORT_SNAPSHOT_PASS",
      "PHASE8_SIGN_IN_SESSION_EVENT_ATOMICITY_PASS",
      "PHASE8_SIGN_IN_FAILURE_INCIDENT_EVENT_ATOMICITY_PASS",
      "P1_3_SIGN_IN_BROWSER_ACCEPTANCE_PASS"
    ]) expect(`${postgresAcceptance}\n${browserAcceptance}`).toContain(marker);
    for (const executableEvidence of [
      "pg_blocking_pids",
      "GlobalSecurityEvent_sequence_seq",
      "concurrentExportPromise=exportGlobalSecurityHistory",
      "phase8_acceptance_reject_event",
      "runEmailSignInThrottleCarrier",
      "synthetic_atomic_evidence_rollback",
      "const captureWriter = spawn(\"docker\"",
      "function runAsync",
      "transactionOptions",
      "timeout: 10_000",
      "phase8_capture_writer_hold",
      "SELECT pg_backend_pid(); SELECT pg_sleep(4)"
    ]) expect(`${postgresAcceptance}\n${browserAcceptance}`).toContain(executableEvidence);
    expect(browserAcceptance).toContain("success-unavailable@acceptance.invalid");
    expect(browserAcceptance).toContain("quiet-handler-unavailable@acceptance.invalid");
    expect(browserAcceptance).toContain("lookup-handler-unavailable@acceptance.invalid");
    expect(browserAcceptance).toContain("synthetic_atomic_session_event_failure");
  });

  it("keeps a real capture-versus-event-writer transition-lock contention probe in the disposable PostgreSQL harness", () => {
    const acceptance = readFileSync(postgresAcceptancePath, "utf8");

    expect(acceptance).toContain("captureGlobalSecurityContext");
    expect(acceptance).toContain("captureReaderApplicationName");
    expect(acceptance).toContain('const captureWriter = spawn("docker"');
    expect(acceptance).toContain("PHASE8_CAPTURE_WRITER_READY");
    expect(acceptance).toContain("function runAsync");
    expect(acceptance).toContain("transactionOptions");
    expect(acceptance).toContain("timeout: 10_000");
    expect(acceptance).toContain("phase8_capture_writer_hold");
    expect(acceptance).toContain("SELECT pg_backend_pid(); SELECT pg_sleep(4)");
    expect(acceptance).toContain("PHASE8_CAPTURE_WRITER_LOCK_ORDER_PASS");
    expect(acceptance).toContain("phase8_capture_writer_wait_missing");
    expect(acceptance).toContain("pg_blocking_pids");
    expect(acceptance).not.toContain("const phase8CaptureWriter = new PrismaClient");
  });
});
