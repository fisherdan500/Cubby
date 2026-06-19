import { endOfMonth, endOfWeek, startOfMonth, startOfWeek } from "date-fns";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { getHouseholdHome } from "@/server/services/households";
import { activityInclude } from "@/server/services/activities";

export async function getCalendar(userId: string, input?: { babyId?: string; month?: string; date?: string }) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "activity.read");
  const home = await getHouseholdHome(userId);
  if (!home) return null;
  const baby = home.household.babies.find((item) => item.id === input?.babyId) ?? home.household.babies[0];
  if (!baby) return { home, baby: null, days: [], selected: null, month: new Date() };

  const month = input?.month ? new Date(`${input.month}-01T00:00:00`) : new Date();
  const rangeStart = startOfWeek(startOfMonth(month));
  const rangeEnd = endOfWeek(endOfMonth(month));
  const activities = await prisma.activityLog.findMany({
    where: {
      householdId: ctx.householdId,
      babyId: baby.id,
      deletedAt: null,
      occurredAt: { gte: rangeStart, lte: rangeEnd }
    },
    include: activityInclude,
    orderBy: { occurredAt: "asc" }
  });
  const events = await prisma.calendarEvent.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      startTime: { gte: rangeStart, lte: rangeEnd },
      OR: [{ babies: { some: { babyId: baby.id } } }, { babies: { none: {} } }]
    },
    include: {
      babies: true,
      contacts: { include: { contact: true } }
    },
    orderBy: { startTime: "asc" }
  });
  const selectedDate = input?.date ? new Date(`${input.date}T00:00:00`) : new Date();
  const selectedKey = dateKey(selectedDate);
  const byDate = new Map<string, typeof activities>();
  for (const activity of activities) {
    const key = dateKey(activity.occurredAt);
    byDate.set(key, [...(byDate.get(key) ?? []), activity]);
  }
  const eventsByDate = new Map<string, typeof events>();
  for (const event of events) {
    const key = dateKey(event.startTime);
    eventsByDate.set(key, [...(eventsByDate.get(key) ?? []), event]);
  }

  const days = [];
  const cursor = new Date(rangeStart);
  while (cursor <= rangeEnd) {
    const key = dateKey(cursor);
    const items = byDate.get(key) ?? [];
    const dayEvents = eventsByDate.get(key) ?? [];
    days.push({
      date: new Date(cursor),
      key,
      inMonth: cursor.getMonth() === month.getMonth(),
      counts: Object.fromEntries(
        Object.entries({ ...groupCounts(items), calendar_event: dayEvents.length }).filter(([, count]) => count > 0)
      ),
      total: items.length + dayEvents.length
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return {
    home,
    baby,
    month,
    days,
    selected: {
      key: selectedKey,
      date: selectedDate,
      activities: byDate.get(selectedKey) ?? [],
      events: eventsByDate.get(selectedKey) ?? []
    }
  };
}

function groupCounts(activities: Awaited<ReturnType<typeof prisma.activityLog.findMany>>) {
  return activities.reduce<Record<string, number>>((acc, activity) => {
    acc[activity.type] = (acc[activity.type] ?? 0) + 1;
    return acc;
  }, {});
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}
