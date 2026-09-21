import { TimerState } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { readHouseholdMemberCandidate } from "@/server/auth/context";
import { getHouseholdHome } from "@/server/services/households";

/**
 * The running timers the app shell shows, for the baby currently in view.
 *
 * This runs on every page, so it reads only what the bar draws and leans on the partial index added
 * in 20260921120000_active_timer_index. It is an affordance rather than a gate: anything unresolved -
 * no household, no baby, no session - returns nothing and the bar simply does not appear.
 */

export type ActiveTimerSummary = {
  id: string;
  type: string;
  babyId: string;
  babyName: string;
  timerState: string;
  startedAt: string | null;
  pausedAt: string | null;
  pausedSeconds: number;
};

export async function getActiveTimersForShell(babyId?: string): Promise<ActiveTimerSummary[]> {
  try {
    if (readHouseholdMemberCandidate().status !== "present") return [];
    const home = await getHouseholdHome();
    if (!home) return [];
    const activeBabies = home.household.babies.filter((baby) => !baby.inactiveAt);
    const baby = activeBabies.find((candidate) => candidate.id === babyId) ?? activeBabies[0];
    if (!baby) return [];

    const timers = await prisma.activityLog.findMany({
      where: {
        householdId: home.householdId,
        babyId: baby.id,
        deletedAt: null,
        timerState: { in: [TimerState.running, TimerState.paused] }
      },
      select: { id: true, type: true, babyId: true, timerState: true, startedAt: true, pausedAt: true, pausedSeconds: true },
      // Most recently started first: the timer you just began is the one the collapsed bar shows.
      orderBy: [{ startedAt: "desc" }, { id: "asc" }]
    });

    return timers.map((timer) => ({
      id: timer.id,
      type: timer.type,
      babyId: timer.babyId,
      babyName: baby.name,
      timerState: timer.timerState,
      startedAt: timer.startedAt?.toISOString() ?? null,
      pausedAt: timer.pausedAt?.toISOString() ?? null,
      pausedSeconds: timer.pausedSeconds
    }));
  } catch {
    return [];
  }
}
