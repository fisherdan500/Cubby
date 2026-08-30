import { prisma } from "@/lib/db/prisma";
import { runEmailChangeLifecycleWorkerTick } from "@/server/services/email-change-lifecycle-worker";

type SchedulerState = { started: boolean; running: boolean; timer: NodeJS.Timeout | null };
declare global { var __cubbyEmailChangeLifecycleScheduler__: SchedulerState | undefined; }

function schedulerState() {
  if (!globalThis.__cubbyEmailChangeLifecycleScheduler__) globalThis.__cubbyEmailChangeLifecycleScheduler__ = { started: false, running: false, timer: null };
  return globalThis.__cubbyEmailChangeLifecycleScheduler__;
}

export async function startEmailChangeLifecycleScheduler() {
  const state = schedulerState();
  if (state.started) return state;
  state.started = true;
  const tick = async (startup = false) => {
    if (state.running) return;
    state.running = true;
    try {
      const result = await runEmailChangeLifecycleWorkerTick(prisma);
      console.info("email_change_lifecycle_result", result.expiredChanges, result.expiredRotations);
    } catch {
      console.error("email_change_lifecycle_tick_failed", "email_change_lifecycle_failed");
      if (startup) throw new Error("email_change_lifecycle_startup_failed");
    } finally {
      state.running = false;
    }
  };
  await tick(true);
  state.timer = setInterval(() => void tick(), 30_000);
  state.timer.unref?.();
  return state;
}
