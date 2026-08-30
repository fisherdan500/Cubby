import { runEmailDeliveryWorkerTick } from "@/server/services/email-delivery-worker";

type SchedulerState = { started: boolean; running: boolean; timer: NodeJS.Timeout | null };
declare global { var __cubbyEmailDeliveryScheduler__: SchedulerState | undefined; }

function schedulerState() {
  if (!globalThis.__cubbyEmailDeliveryScheduler__) globalThis.__cubbyEmailDeliveryScheduler__ = { started: false, running: false, timer: null };
  return globalThis.__cubbyEmailDeliveryScheduler__;
}

export async function startEmailDeliveryScheduler() {
  const state = schedulerState();
  if (state.started) return state;
  state.started = true;
  const tick = async (startup = false) => {
    if (state.running) return;
    state.running = true;
    try {
      const result = await runEmailDeliveryWorkerTick();
      console.info("email_delivery_result", result.accepted, result.failed, result.idle);
    } catch {
      console.error("email_delivery_tick_failed", "email_delivery_failed");
      if (startup) throw new Error("email_delivery_startup_failed");
    } finally {
      state.running = false;
    }
  };
  await tick(true);
  state.timer = setInterval(() => void tick(), 30_000);
  state.timer.unref?.();
  return state;
}
