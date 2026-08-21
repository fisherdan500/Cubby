import { runBrowserOperationRetention } from "@/server/services/browser-operation-retention";

const pollMs = 15 * 60 * 1000;

type BrowserOperationRetentionSchedulerState = {
  started: boolean;
  running: boolean;
  timer: NodeJS.Timeout | null;
};

declare global {
  var __cubbyBrowserOperationRetentionScheduler__: BrowserOperationRetentionSchedulerState | undefined;
}

function schedulerState(): BrowserOperationRetentionSchedulerState {
  if (!globalThis.__cubbyBrowserOperationRetentionScheduler__) {
    globalThis.__cubbyBrowserOperationRetentionScheduler__ = { started: false, running: false, timer: null };
  }
  return globalThis.__cubbyBrowserOperationRetentionScheduler__;
}

export async function startBrowserOperationRetentionScheduler() {
  const state = schedulerState();
  if (state.started) return state;
  state.started = true;

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      const result = await runBrowserOperationRetention({ batchSize: 100 });
      console.info(
        "browser_operation_retention_result",
        "household",
        result.household.unresolvedAlertCount,
        result.household.compactedCount,
        result.household.deletedBindingCount,
        "account",
        result.account.unresolvedAlertCount,
        result.account.compactedCount,
        result.account.deletedBindingCount
      );
    } catch {
      console.error("browser_operation_retention_tick_failed", "browser_operation_retention_failed");
    } finally {
      state.running = false;
    }
  };

  await tick();
  state.timer = setInterval(() => void tick(), pollMs);
  state.timer.unref?.();
  return state;
}
