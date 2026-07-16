import { automatedBackupConfig } from "@/lib/env";
import {
  reconcileAutomatedBackupStorage,
  runAutomatedBackupScan,
  sanitizeAutomatedBackupError
} from "@/server/services/automated-backups";

type SchedulerState = {
  started: boolean;
  running: boolean;
  timer: NodeJS.Timeout | null;
};

declare global {
  var __cubbyAutomatedBackupScheduler__: SchedulerState | undefined;
}

function getState(): SchedulerState {
  if (!globalThis.__cubbyAutomatedBackupScheduler__) {
    globalThis.__cubbyAutomatedBackupScheduler__ = { started: false, running: false, timer: null };
  }
  return globalThis.__cubbyAutomatedBackupScheduler__;
}

export async function startAutomatedBackupScheduler() {
  const state = getState();
  if (state.started || !automatedBackupConfig.enabled) return state;
  state.started = true;

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      await runAutomatedBackupScan(new Date(), automatedBackupConfig);
    } catch (error) {
      console.error("backup_scheduler_tick_failed", sanitizeAutomatedBackupError(error));
    } finally {
      state.running = false;
    }
  };

  try {
    await reconcileAutomatedBackupStorage(automatedBackupConfig);
  } catch (error) {
    console.error("backup_scheduler_reconcile_failed", sanitizeAutomatedBackupError(error));
  }
  await tick();

  state.timer = setInterval(() => {
    void tick();
  }, automatedBackupConfig.pollMinutes * 60 * 1000);
  state.timer.unref?.();
  return state;
}
