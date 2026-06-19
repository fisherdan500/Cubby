import { ActivityType, TimerState } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdHome } from "@/server/services/households";
import { activityInclude } from "@/server/services/activities";

export async function getDashboard(userId: string, babyId?: string) {
  const home = await getHouseholdHome(userId);
  if (!home) return null;
  const baby = home.household.babies.find((item) => item.id === babyId) ?? home.household.babies[0];
  if (!baby) return { home, baby: null, activities: [], activeTimers: [], summaries: {} };

  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const [activities, activeTimers, counts, lastFeeding, lastDiaper, lastSleep] = await Promise.all([
    prisma.activityLog.findMany({
      where: { householdId: home.householdId, babyId: baby.id, deletedAt: null },
      include: activityInclude,
      orderBy: { occurredAt: "desc" },
      take: 12
    }),
    prisma.activityLog.findMany({
      where: {
        householdId: home.householdId,
        babyId: baby.id,
        deletedAt: null,
        timerState: TimerState.running
      },
      include: activityInclude,
      orderBy: { startedAt: "desc" }
    }),
    prisma.activityLog.groupBy({
      by: ["type"],
      where: {
        householdId: home.householdId,
        babyId: baby.id,
        deletedAt: null,
        occurredAt: { gte: since }
      },
      _count: true
    }),
    prisma.activityLog.findFirst({
      where: { householdId: home.householdId, babyId: baby.id, deletedAt: null, type: ActivityType.feeding },
      include: activityInclude,
      orderBy: { occurredAt: "desc" }
    }),
    prisma.activityLog.findFirst({
      where: { householdId: home.householdId, babyId: baby.id, deletedAt: null, type: ActivityType.diaper },
      include: activityInclude,
      orderBy: { occurredAt: "desc" }
    }),
    prisma.activityLog.findFirst({
      where: { householdId: home.householdId, babyId: baby.id, deletedAt: null, type: ActivityType.sleep },
      include: activityInclude,
      orderBy: { occurredAt: "desc" }
    })
  ]);

  return {
    home,
    baby,
    activities,
    activeTimers,
    lastFeeding,
    lastDiaper,
    lastSleep,
    summaries: Object.fromEntries(counts.map((count) => [count.type, count._count]))
  };
}

export function warningState(input: {
  lastFeeding?: { occurredAt: Date } | null;
  lastDiaper?: { occurredAt: Date } | null;
  activeTimers: Array<{ startedAt: Date | null; type: string }>;
}) {
  const now = Date.now();
  return {
    feedingLate: !input.lastFeeding || now - input.lastFeeding.occurredAt.getTime() > 4 * 60 * 60 * 1000,
    diaperLate: !input.lastDiaper || now - input.lastDiaper.occurredAt.getTime() > 4 * 60 * 60 * 1000,
    timerLong: input.activeTimers.some(
      (timer) => timer.startedAt && now - timer.startedAt.getTime() > 6 * 60 * 60 * 1000
    )
  };
}
