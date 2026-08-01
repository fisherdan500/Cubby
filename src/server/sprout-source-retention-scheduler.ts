import { runSproutSourceRetention } from "@/server/services/sprout-source-retention";

const POLL_MS = 15 * 60 * 1000;

type SchedulerState = {
  started: boolean;
  running: boolean;
  timer: NodeJS.Timeout | null;
};

declare global {
  var __cubbySproutSourceRetentionScheduler__: SchedulerState | undefined;
}

function getState(): SchedulerState {
  if (!globalThis.__cubbySproutSourceRetentionScheduler__) {
    globalThis.__cubbySproutSourceRetentionScheduler__ = { started: false, running: false, timer: null };
  }
  return globalThis.__cubbySproutSourceRetentionScheduler__;
}

export async function startSproutSourceRetentionScheduler() {
  const state = getState();
  if (state.started) return state;
  state.started = true;

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      await runSproutSourceRetention();
    } catch {
      console.error("sprout_source_retention_tick_failed", "sprout_source_retention_failed");
    } finally {
      state.running = false;
    }
  };

  await tick();
  state.timer = setInterval(() => {
    void tick();
  }, POLL_MS);
  state.timer.unref?.();
  return state;
}
