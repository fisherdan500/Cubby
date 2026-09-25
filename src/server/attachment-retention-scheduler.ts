import { purgeDueAttachments } from "@/server/services/attachments";

const POLL_MS = 15 * 60 * 1000;

type SchedulerState = {
  started: boolean;
  running: boolean;
  timer: NodeJS.Timeout | null;
};

declare global {
  var __cubbyAttachmentRetentionScheduler__: SchedulerState | undefined;
}

function getState(): SchedulerState {
  if (!globalThis.__cubbyAttachmentRetentionScheduler__) {
    globalThis.__cubbyAttachmentRetentionScheduler__ = { started: false, running: false, timer: null };
  }
  return globalThis.__cubbyAttachmentRetentionScheduler__;
}

/**
 * Erases removed attachments once their thirty days are up, and uploads nothing claimed within a
 * day (DEC-PROD-146). Failures are logged by code only: paths and names never reach the log.
 */
export async function startAttachmentRetentionScheduler() {
  const state = getState();
  if (state.started) return state;
  state.started = true;

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      await purgeDueAttachments();
    } catch {
      console.error("attachment_retention_tick_failed", "attachment_retention_failed");
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
