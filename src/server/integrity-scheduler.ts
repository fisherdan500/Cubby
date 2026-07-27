import { integrityConfig } from "@/lib/env";
import { prisma } from "@/lib/db/prisma";
import { runScheduledIntegritySuite } from "@/server/services/integrity";

type SchedulerState = {
  started: boolean;
  running: boolean;
  timer: NodeJS.Timeout | null;
};

declare global {
  var __cubbyIntegrityScheduler__: SchedulerState | undefined;
}

function getState(): SchedulerState {
  if (!globalThis.__cubbyIntegrityScheduler__) {
    globalThis.__cubbyIntegrityScheduler__ = { started: false, running: false, timer: null };
  }
  return globalThis.__cubbyIntegrityScheduler__;
}

export async function startIntegrityScheduler() {
  const state = getState();
  if (state.started || !integrityConfig.enabled) return state;
  state.started = true;

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      const result = await runScheduledIntegritySuite(prisma);
      if (!result.executed) return;
      const { report } = result;
      console.info("integrity_scheduler_result", report.status, report.version, report.findings.length, report.evidenceFingerprint);
    } catch {
      console.error("integrity_scheduler_result", "incomplete");
    } finally {
      state.running = false;
    }
  };

  await tick();
  state.timer = setInterval(() => {
    void tick();
  }, integrityConfig.intervalHours * 60 * 60 * 1000);
  state.timer.unref?.();
  return state;
}
