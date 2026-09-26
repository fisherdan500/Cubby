import { runPlatformHealthCheck } from "@/server/services/platform-health";

const POLL_MS = 60 * 60 * 1000;

type SchedulerState = {
  started: boolean;
  running: boolean;
  timer: NodeJS.Timeout | null;
};

declare global {
  var __cubbyPlatformHealthScheduler__: SchedulerState | undefined;
}

function getState(): SchedulerState {
  if (!globalThis.__cubbyPlatformHealthScheduler__) {
    globalThis.__cubbyPlatformHealthScheduler__ = { started: false, running: false, timer: null };
  }
  return globalThis.__cubbyPlatformHealthScheduler__;
}

/**
 * Checks backups and free space every hour and emails the platform owner when something needs
 * attention. Failures are logged by code only.
 */
export async function startPlatformHealthScheduler() {
  const state = getState();
  if (state.started) return state;
  state.started = true;

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      await runPlatformHealthCheck();
    } catch {
      console.error("platform_health_tick_failed", "platform_health_failed");
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
