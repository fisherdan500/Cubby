const acceptanceStagePath = "/run/cubby-acceptance-status/instrumentation-stage";

function acceptanceInstrumentationEnabled() {
  return process.env.NEXT_RUNTIME === "nodejs"
    && process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL === "1"
    && process.env.CUBBY_P13_ACCEPTANCE_INSTRUMENTATION_STAGE_FILE === acceptanceStagePath;
}

type WriteAcceptanceStage = (stage: string) => void;

function writeCompletedSchedulerStage(index: number, writeAcceptanceStage: WriteAcceptanceStage) {
  switch (index) {
    case 0: writeAcceptanceStage("automated_backup_started"); break;
    case 1: writeAcceptanceStage("integrity_started"); break;
    case 2: writeAcceptanceStage("sprout_retention_started"); break;
    case 3: writeAcceptanceStage("browser_operation_retention_started"); break;
    case 4: writeAcceptanceStage("email_delivery_started"); break;
    case 5: writeAcceptanceStage("email_change_lifecycle_started"); break;
  }
}

const acceptanceInstrumentation = acceptanceInstrumentationEnabled();
let writeAcceptanceStage: WriteAcceptanceStage = () => {};
if (acceptanceInstrumentation) {
  const fileSystem = process.getBuiltinModule("fs");
  writeAcceptanceStage = (stage) => {
    fileSystem.writeFileSync(acceptanceStagePath, `${stage}\n`, { encoding: "utf8", flag: "w", mode: 0o600 });
  };
  writeAcceptanceStage("module_evaluated");
}

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (acceptanceInstrumentation) writeAcceptanceStage("register_entered");
    const [
      { startAutomatedBackupScheduler },
      { startIntegrityScheduler },
      { startSproutSourceRetentionScheduler },
      { startBrowserOperationRetentionScheduler },
      { startEmailDeliveryScheduler },
      { startEmailChangeLifecycleScheduler }
    ] = await Promise.all([
      import("@/server/automated-backup-scheduler"),
      import("@/server/integrity-scheduler"),
      import("@/server/sprout-source-retention-scheduler"),
      import("@/server/browser-operation-retention-scheduler"),
      import("@/server/email-delivery-scheduler"),
      import("@/server/email-change-lifecycle-scheduler")
    ]);
    if (acceptanceInstrumentation) writeAcceptanceStage("modules_loaded");
    const completed = [false, false, false, false, false, false];
    let contiguousCompleted = -1;
    const markCompleted = (index: number) => {
      if (!acceptanceInstrumentation) return;
      completed[index] = true;
      while (completed[contiguousCompleted + 1]) {
        contiguousCompleted += 1;
        writeCompletedSchedulerStage(contiguousCompleted, writeAcceptanceStage);
      }
    };
    await Promise.all([
      Promise.resolve(startAutomatedBackupScheduler()).then(() => markCompleted(0)),
      Promise.resolve(startIntegrityScheduler()).then(() => markCompleted(1)),
      Promise.resolve(startSproutSourceRetentionScheduler()).then(() => markCompleted(2)),
      Promise.resolve(startBrowserOperationRetentionScheduler()).then(() => markCompleted(3)),
      Promise.resolve(startEmailDeliveryScheduler()).then(() => markCompleted(4)),
      Promise.resolve(startEmailChangeLifecycleScheduler()).then(() => markCompleted(5))
    ]);
    // Started after the fixed acceptance stages, so their sequence is unchanged.
    const { startAttachmentRetentionScheduler } = await import("@/server/attachment-retention-scheduler");
    await startAttachmentRetentionScheduler();
  }
}
