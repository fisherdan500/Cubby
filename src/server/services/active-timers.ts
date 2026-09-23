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
    const hasSelectedBaby = babyId !== undefined;
    const selectedBaby = hasSelectedBaby ? activeBabies.find((candidate) => candidate.id === babyId) : undefined;
    if (hasSelectedBaby && !selectedBaby) return [];
    if (activeBabies.length === 0) return [];
    const nameCounts = new Map<string, number>();
    for (const baby of activeBabies) nameCounts.set(baby.name, (nameCounts.get(baby.name) ?? 0) + 1);
    const namePositions = new Map<string, number>();
    const babyNames = new Map(activeBabies.map((baby) => {
      const count = nameCounts.get(baby.name) ?? 1;
      const position = (namePositions.get(baby.name) ?? 0) + 1;
      namePositions.set(baby.name, position);
      return [baby.id, count > 1 ? `${baby.name} (baby ${position} of ${count})` : baby.name];
    }));

    const timers = await prisma.activityLog.findMany({
      where: {
        householdId: home.householdId,
        babyId: selectedBaby?.id ?? { in: activeBabies.map((baby) => baby.id) },
        deletedAt: null,
        timerState: { in: [TimerState.running, TimerState.paused] }
      },
      select: { id: true, type: true, babyId: true, timerState: true, startedAt: true, pausedAt: true, pausedSeconds: true },
      // Most recently started first: the timer you just began is the one the collapsed bar shows.
      orderBy: [{ startedAt: "desc" }, { id: "asc" }]
    });

    return timers.flatMap((timer) => {
      const babyName = babyNames.get(timer.babyId);
      if (!babyName) return [];
      return [{
        id: timer.id,
        type: timer.type,
        babyId: timer.babyId,
        babyName,
        timerState: timer.timerState,
        startedAt: timer.startedAt?.toISOString() ?? null,
        pausedAt: timer.pausedAt?.toISOString() ?? null,
        pausedSeconds: timer.pausedSeconds
      }];
    });
  } catch {
    return [];
  }
}
