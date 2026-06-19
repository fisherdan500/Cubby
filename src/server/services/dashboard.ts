import { ActivityType, DiaperKind, FeedingKind, TimerState, type Prisma } from "@prisma/client";
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

  const [activities, activeTimers, counts, todayActivities, lastFeeding, lastDiaper, lastSleep] = await Promise.all([
    prisma.activityLog.findMany({
      where: { householdId: home.householdId, babyId: baby.id, deletedAt: null },
      include: activityInclude,
      orderBy: { occurredAt: "desc" },
      take: 30
    }),
    prisma.activityLog.findMany({
      where: {
        householdId: home.householdId,
        babyId: baby.id,
        deletedAt: null,
        timerState: { in: [TimerState.running, TimerState.paused] }
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
    prisma.activityLog.findMany({
      where: {
        householdId: home.householdId,
        babyId: baby.id,
        deletedAt: null,
        occurredAt: { gte: since }
      },
      include: activityInclude,
      orderBy: { occurredAt: "desc" }
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
    dailySummary: summarizeDay(todayActivities),
    summaries: Object.fromEntries(counts.map((count) => [count.type, count._count]))
  };
}

export function warningState(input: {
  lastFeeding?: { occurredAt: Date } | null;
  lastDiaper?: { occurredAt: Date } | null;
  activeTimers: Array<{ startedAt: Date | null; type: string }>;
  feedingWarningMinutes?: number | null;
  diaperWarningMinutes?: number | null;
  sleepWarningMinutes?: number | null;
}) {
  const now = Date.now();
  const feedingMinutes = input.feedingWarningMinutes ?? 4 * 60;
  const diaperMinutes = input.diaperWarningMinutes ?? 4 * 60;
  const sleepMinutes = input.sleepWarningMinutes ?? 6 * 60;
  return {
    feedingLate: !input.lastFeeding || now - input.lastFeeding.occurredAt.getTime() > feedingMinutes * 60 * 1000,
    diaperLate: !input.lastDiaper || now - input.lastDiaper.occurredAt.getTime() > diaperMinutes * 60 * 1000,
    timerLong: input.activeTimers.some(
      (timer) => timer.startedAt && now - timer.startedAt.getTime() > sleepMinutes * 60 * 1000
    )
  };
}

type DashboardActivity = Prisma.ActivityLogGetPayload<{ include: typeof activityInclude }>;

function summarizeDay(activities: DashboardActivity[]) {
  let sleepSeconds = 0;
  let feeds = 0;
  let wetDiapers = 0;
  let dirtyDiapers = 0;
  let pumped = 0;

  for (const activity of activities) {
    if (activity.type === ActivityType.sleep) sleepSeconds += activity.durationSeconds ?? 0;
    if (activity.feeding?.mode === FeedingKind.bottle || activity.feeding?.mode === FeedingKind.formula) feeds += 1;
    if (activity.diaper?.kind === DiaperKind.wet || activity.diaper?.kind === DiaperKind.mixed) wetDiapers += 1;
    if (activity.diaper?.kind === DiaperKind.dirty || activity.diaper?.kind === DiaperKind.mixed) dirtyDiapers += 1;
    if (activity.pumping?.amount) pumped += Number(activity.pumping.amount);
  }

  return {
    sleepSeconds,
    feeds,
    wetDiapers,
    dirtyDiapers,
    pumped
  };
}
