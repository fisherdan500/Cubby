import { describe, expect, it } from "vitest";
import { executeRecoverySubmitServiceDiagnostic, recoverySubmitLifecycleFailureCode, recoverySubmitQueryFailureClass, trackedRecoverySubmitLifecycle } from "../../../scripts/p1-3-recovery-submit-probe-contract";

describe("recovery submit source-first diagnostic", () => {
  it("runs only PostgreSQL service boundaries and always tears down", async () => {
    const calls: string[] = [];
    const lifecycle = Object.fromEntries(["prepare", "migrate", "verifyDatabase", "verifyInvitationRuntime", "verifySmtp", "verifyBrowserCdp", "cleanup"].map(name => [name, async () => { calls.push(name); }])) as unknown as Parameters<typeof executeRecoverySubmitServiceDiagnostic>[0];
    await executeRecoverySubmitServiceDiagnostic(lifecycle);
    expect(calls.join(",") === "prepare,migrate,verifyDatabase,verifyInvitationRuntime,cleanup").toBe(true);
  });

  it("tears down on a real failed postcondition and preserves cleanup failure", async () => {
    let cleaned = false;
    const lifecycle = { prepare: async () => {}, migrate: async () => {}, verifyDatabase: async () => {}, verifyInvitationRuntime: async () => { if (!cleaned) throw new Error("source_postcondition_failed"); }, cleanup: async () => { cleaned = true; } };
    await expect(executeRecoverySubmitServiceDiagnostic(lifecycle)).rejects.toThrow("source_postcondition_failed");
    expect(cleaned).toBe(true);
    lifecycle.cleanup = async () => { throw new Error("source_cleanup_failed"); };
    await expect(executeRecoverySubmitServiceDiagnostic(lifecycle)).rejects.toThrow("source_cleanup_failed");
  });

  it("reduces only approved SQLSTATE metadata and never reads error details", () => {
    for (const state of ["22023", "23502", "23503", "23505", "42501", "42703", "42704", "42883", "0A000", "P0001"] as const) {
      const error = { code: "P2010", meta: { code: state, get message(): never { throw new Error("forbidden_detail_access"); } }, get message(): never { throw new Error("forbidden_message_access"); } };
      expect(recoverySubmitQueryFailureClass(error) === state).toBe(true);
    }
    expect(recoverySubmitQueryFailureClass({ code: "P2010", meta: { code: "unapproved" } }) === "other").toBe(true);
    expect(recoverySubmitQueryFailureClass(null) === "other").toBe(true);
  });
});

describe("recovery submit lifecycle boundary classification", () => {
  it("names the failing lifecycle stage and a fixed error class without reading any message text", () => {
    const stages = ["prepare", "migrate", "verify_database", "verify_invitation_runtime", "cleanup"] as const;
    for (const stage of stages) {
      expect(recoverySubmitLifecycleFailureCode(stage, Object.assign(new Error("private detail"), { code: "ENOENT" })))
        .toBe(`p1_3_recovery_service_lifecycle_${stage}_enoent`);
    }
    expect(recoverySubmitLifecycleFailureCode("prepare", Object.assign(new Error(), { code: "ETIMEDOUT" })))
      .toBe("p1_3_recovery_service_lifecycle_prepare_etimedout");
    expect(recoverySubmitLifecycleFailureCode("migrate", new TypeError("private detail")))
      .toBe("p1_3_recovery_service_lifecycle_migrate_typeerror");
    expect(recoverySubmitLifecycleFailureCode("cleanup", new Error("private detail")))
      .toBe("p1_3_recovery_service_lifecycle_cleanup_error");
    expect(recoverySubmitLifecycleFailureCode("prepare", { weird: true }))
      .toBe("p1_3_recovery_service_lifecycle_prepare_other");
    expect(recoverySubmitLifecycleFailureCode("not_a_stage" as never, new Error()))
      .toBe("p1_3_recovery_service_lifecycle_unknown_error");
    // A message that is already a fixed protocol code must survive unchanged.
    expect(recoverySubmitLifecycleFailureCode("migrate", new Error("p1_3_invitation_acceptance_migrate_failed")))
      .toBe("p1_3_invitation_acceptance_migrate_failed");
  });

  it("records the stage actually reached before a failure", async () => {
    const record: { stage: string; failedStage?: string } = { stage: "prepare" };
    const base = {
      prepare: async () => {}, migrate: async () => {}, verifyDatabase: async () => {},
      verifyInvitationRuntime: async () => { throw new Error("private detail"); }, cleanup: async () => {}
    };
    const tracked = trackedRecoverySubmitLifecycle(base, record);
    await expect(executeRecoverySubmitServiceDiagnostic(tracked)).rejects.toThrow();
    // Cleanup runs in the finally path, so the retained failing stage is the meaningful boundary.
    expect(record.failedStage).toBe("verify_invitation_runtime");
    expect(record.stage).toBe("cleanup");
  });
});
