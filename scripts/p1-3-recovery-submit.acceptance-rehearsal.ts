import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { executeRecoverySubmitServiceDiagnostic, recoverySubmitLifecycleFailureCode, trackedRecoverySubmitLifecycle, type RecoverySubmitLifecycleStage } from "./p1-3-recovery-submit-probe-contract";

async function main() {
  const prior = process.env.VITEST;
  process.env.VITEST = "true";
  const { createLifecycle, p13InvitationAcceptanceFailureCode } = await import("./p1-3-invitation.acceptance-rehearsal");
  if (prior === undefined) delete process.env.VITEST; else process.env.VITEST = prior;
  let failure: string | undefined;
  const stageRecord: { stage: string; failedStage?: string } = { stage: "prepare" };
  try {
    await executeRecoverySubmitServiceDiagnostic(trackedRecoverySubmitLifecycle(createLifecycle("diagnostic", async (context) => {
      await new Promise<void>((resolveProbe, rejectProbe) => {
        const child = spawn(process.execPath, ["--import", "tsx", resolve("scripts/p1-3-recovery-submit.service-probe.ts")], {
          cwd: process.cwd(), env: { ...context.env, CUBBY_P13_RECOVERY_SERVICE_PROBE: "1", CUBBY_P13_ACCEPTANCE_HEALTH_SENTINEL: "1" },
          stdio: ["ignore", "ignore", "ignore", "ipc"], timeout: 180_000
        });
        let invalid = false;
        child.on("message", (message) => {
          if (typeof message !== "string" || !/^p1_3_recovery_service_(?:(?:fixture|credential|reserve|authorize|fresh_auth|bind|batch|submit|receipt|replay)_sqlstate_(?:22023|23502|23503|23505|42501|42703|42704|42883|0A000|P0001|other)|cleanup_failed)$/.test(message)) invalid = true;
          else if (failure && message !== "p1_3_recovery_service_cleanup_failed") invalid = true;
          else failure = message;
        });
        child.once("error", () => rejectProbe(new Error("p1_3_invitation_acceptance_runtime_probe_process_failed")));
        child.once("exit", (status) => {
          if (invalid || (status === 0 && failure)) { failure = "p1_3_recovery_service_output_invalid"; rejectProbe(new Error()); }
          else if (status === 0) resolveProbe();
          else rejectProbe(new Error("p1_3_invitation_acceptance_runtime_probe_process_failed"));
        });
      });
    }), stageRecord));
    process.stdout.write("p1_3_recovery_service_complete\n");
  } catch (error) {
    const lifecycleFailure = p13InvitationAcceptanceFailureCode(error);
    const cleanupFailure = lifecycleFailure.includes("cleanup") || lifecycleFailure.includes("normal_runtime");
    // An error that is not one of our own fixed codes still names its exact stage and a fixed class.
    const identified = lifecycleFailure === "p1_3_invitation_acceptance_failed"
      ? recoverySubmitLifecycleFailureCode((stageRecord.failedStage ?? stageRecord.stage) as RecoverySubmitLifecycleStage, error)
      : lifecycleFailure;
    process.stdout.write(`${cleanupFailure ? lifecycleFailure : failure ?? identified}\n`);
    process.exitCode = 1;
  }
}

void main().catch(() => { process.stdout.write("p1_3_recovery_service_launcher_failed\n"); process.exitCode = 1; });
