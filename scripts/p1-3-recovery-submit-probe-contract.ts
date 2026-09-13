type RecoveryServiceLifecycle = {
  prepare(): Promise<void>;
  migrate(): Promise<void>;
  verifyDatabase(): Promise<void>;
  verifyInvitationRuntime(): Promise<void>;
  cleanup(): Promise<void>;
};

export async function executeRecoverySubmitServiceDiagnostic(lifecycle: RecoveryServiceLifecycle) {
  try {
    await lifecycle.prepare();
    await lifecycle.migrate();
    await lifecycle.verifyDatabase();
    await lifecycle.verifyInvitationRuntime();
  } finally {
    await lifecycle.cleanup();
  }
}

export function recoverySubmitQueryFailureClass(error: unknown) {
  const state = error && typeof error === "object" && "meta" in error
    && error.meta && typeof error.meta === "object" && "code" in error.meta ? error.meta.code : undefined;
  return state === "22023" || state === "23502" || state === "23503" || state === "23505"
    || state === "42501" || state === "42703" || state === "42704" || state === "42883"
    || state === "0A000" || state === "P0001" ? state : "other";
}

const lifecycleStages = ["prepare", "migrate", "verify_database", "verify_invitation_runtime", "cleanup"] as const;
export type RecoverySubmitLifecycleStage = typeof lifecycleStages[number];

/** Fixed operating-system and runtime error classes. No message, path or detail is ever read. */
const lifecycleErrorCodes = new Set([
  "ENOENT", "EACCES", "EPERM", "EEXIST", "ENOTDIR", "EISDIR", "EBUSY", "EMFILE", "ENOSPC",
  "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "EADDRINUSE", "ERR_IPC_CHANNEL_CLOSED"
]);
const lifecycleErrorNames = new Set(["TypeError", "RangeError", "SyntaxError", "ReferenceError", "AggregateError", "Error"]);

export function recoverySubmitLifecycleErrorClass(error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const code = record && typeof record.code === "string" ? record.code : undefined;
  if (code && lifecycleErrorCodes.has(code)) return code.toLowerCase().replace(/^err_/, "");
  const name = record && typeof record.name === "string" ? record.name : undefined;
  if (name && lifecycleErrorNames.has(name)) return name.toLowerCase();
  return "other";
}

/** Identifies the exact disposable stage and a fixed error class, never raw diagnostic content. */
export function recoverySubmitLifecycleFailureCode(stage: RecoverySubmitLifecycleStage, error: unknown) {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : undefined;
  const message = record && typeof record.message === "string" ? record.message : "";
  if (/^p1_3_[a-z0-9_]{1,120}$/.test(message)) return message;
  const named = (lifecycleStages as readonly string[]).includes(stage) ? stage : "unknown";
  return `p1_3_recovery_service_lifecycle_${named}_${recoverySubmitLifecycleErrorClass(error)}`;
}

/**
 * Records which stage a lifecycle reached so a failure can name its own boundary. Cleanup always runs
 * in the finally path, so the first failing stage is retained separately from the current one.
 */
export function trackedRecoverySubmitLifecycle(lifecycle: RecoveryServiceLifecycle, record: { stage: string; failedStage?: string }): RecoveryServiceLifecycle {
  const names: Array<[keyof RecoveryServiceLifecycle, RecoverySubmitLifecycleStage]> = [
    ["prepare", "prepare"], ["migrate", "migrate"], ["verifyDatabase", "verify_database"],
    ["verifyInvitationRuntime", "verify_invitation_runtime"], ["cleanup", "cleanup"]
  ];
  const tracked = {} as RecoveryServiceLifecycle;
  for (const [method, stage] of names) {
    tracked[method] = async () => {
      record.stage = stage;
      try {
        await lifecycle[method]();
      } catch (error) {
        record.failedStage ??= stage;
        throw error;
      }
    };
  }
  return tracked;
}
