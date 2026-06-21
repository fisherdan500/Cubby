import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { addDaysToDateKey, dateKeyInTimeZone, zonedDateStart, zonedDateTimeToDate } from "@/lib/timezone";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { getHouseholdHome } from "@/server/services/households";
import { activityInclude } from "@/server/services/activities";
import { writeAudit } from "@/server/services/audit";

const dateKeyPattern = /^\d{4}-\d{2}-\d{2}$/;
const monthKeyPattern = /^\d{4}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;

const calendarEventSchema = z.object({
  babyId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  eventType: z.string().trim().max(80).optional().transform(emptyToUndefined),
  description: z.string().trim().max(2000).optional().transform(emptyToUndefined),
  location: z.string().trim().max(200).optional().transform(emptyToUndefined),
  color: z
    .string()
    .trim()
    .optional()
    .transform((value) => (/^#[0-9a-fA-F]{6}$/.test(value ?? "") ? value : undefined)),
  allDay: z.preprocess((value) => value === "on" || value === "true" || value === true, z.boolean().default(false)),
  startDate: z.string().regex(dateKeyPattern),
  startTime: z.string().regex(timePattern).default("09:00"),
  endDate: z.string().regex(dateKeyPattern).optional().or(z.literal("")).transform(emptyToUndefined),
  endTime: z.string().regex(timePattern).optional().or(z.literal("")).transform(emptyToUndefined)
});

export type CalendarEventCreateResult = {
  id: string;
  babyId: string;
  date: string;
  month: string;
};

export async function getCalendar(
  userId: string,
  input?: { babyId?: string; month?: string; date?: string; eventId?: string }
) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "activity.read");
  const home = await getHouseholdHome(userId);
  if (!home) return null;
  const baby = home.household.babies.find((item) => item.id === input?.babyId) ?? home.household.babies[0];
  if (!baby) {
    return {
      home,
      baby: null,
      days: [],
      selected: null,
      selectedEvent: null,
      monthKey: resolveMonthKey(input?.month),
      monthLabel: formatMonthLabel(resolveMonthKey(input?.month)),
      previousMonth: "",
      nextMonth: "",
      todayKey: dateKeyInTimeZone(new Date(), env.APP_TIMEZONE),
      timezone: env.APP_TIMEZONE
    };
  }

  const monthKey = resolveMonthKey(input?.month);
  const visibleKeys = monthGridDateKeys(monthKey);
  const rangeStart = zonedDateStart(visibleKeys[0], env.APP_TIMEZONE);
  const rangeEnd = zonedDateStart(addDaysToDateKey(visibleKeys[visibleKeys.length - 1], 1), env.APP_TIMEZONE);
  const activities = await prisma.activityLog.findMany({
    where: {
      householdId: ctx.householdId,
      babyId: baby.id,
      deletedAt: null,
      occurredAt: { gte: rangeStart, lt: rangeEnd }
    },
    include: activityInclude,
    orderBy: { occurredAt: "asc" }
  });
  const events = await prisma.calendarEvent.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      AND: [
        { startTime: { lt: rangeEnd } },
        { OR: [{ endTime: { gt: rangeStart } }, { endTime: null, startTime: { gte: rangeStart } }] },
        { OR: [{ babies: { some: { babyId: baby.id } } }, { babies: { none: {} } }] }
      ]
    },
    include: {
      babies: true,
      contacts: { include: { contact: true } }
    },
    orderBy: { startTime: "asc" }
  });

  const byDate = new Map<string, typeof activities>();
  for (const activity of activities) {
    const key = dateKeyInTimeZone(activity.occurredAt, env.APP_TIMEZONE);
    byDate.set(key, [...(byDate.get(key) ?? []), activity]);
  }

  const days = [];
  for (const key of visibleKeys) {
    const items = byDate.get(key) ?? [];
    const dayStart = zonedDateStart(key, env.APP_TIMEZONE);
    const dayEnd = zonedDateStart(addDaysToDateKey(key, 1), env.APP_TIMEZONE);
    const dayEvents = events.filter((event) => eventOverlapsDay(event, dayStart, dayEnd));
    days.push({
      date: keyToNoonDate(key),
      key,
      dayNumber: Number(key.slice(8, 10)),
      inMonth: key.slice(0, 7) === monthKey,
      counts: Object.fromEntries(
        Object.entries(groupCounts(items)).filter(([, count]) => count > 0)
      ),
      total: items.length + dayEvents.length,
      activities: items,
      events: dayEvents
    });
  }

  const selectedKey = isValidDateKey(input?.date) ? input.date : undefined;
  const selected = selectedKey
    ? days.find((day) => day.key === selectedKey) ?? {
        key: selectedKey,
        date: keyToNoonDate(selectedKey),
        dayNumber: Number(selectedKey.slice(8, 10)),
        inMonth: selectedKey.slice(0, 7) === monthKey,
        counts: {},
        total: 0,
        activities: [],
        events: events.filter((event) =>
          eventOverlapsDay(event, zonedDateStart(selectedKey, env.APP_TIMEZONE), zonedDateStart(addDaysToDateKey(selectedKey, 1), env.APP_TIMEZONE))
        )
      }
    : null;
  const selectedEvent = selected?.events.find((event) => event.id === input?.eventId) ?? null;

  return {
    home,
    baby,
    monthKey,
    monthLabel: formatMonthLabel(monthKey),
    previousMonth: addMonthsToMonthKey(monthKey, -1),
    nextMonth: addMonthsToMonthKey(monthKey, 1),
    todayKey: dateKeyInTimeZone(new Date(), env.APP_TIMEZONE),
    timezone: env.APP_TIMEZONE,
    days,
    selected: selected
      ? {
          ...selected,
          label: formatDateKeyLabel(selected.key)
        }
      : null,
    selectedEvent
  };
}

export async function createCalendarEvent(raw: unknown): Promise<CalendarEventCreateResult> {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "activity.create");
  const input = calendarEventSchema.parse(raw);
  const baby = await prisma.baby.findFirst({
    where: { id: input.babyId, householdId: ctx.householdId, deletedAt: null },
    select: { id: true }
  });
  if (!baby) throw new Error("not_found");

  const startTime = input.allDay
    ? zonedDateStart(input.startDate, env.APP_TIMEZONE)
    : zonedDateTimeToDate(`${input.startDate}T${input.startTime}`, env.APP_TIMEZONE);
  const endTime = resolveEventEnd(input);
  if (endTime && endTime <= startTime) throw new Error("invalid_date_range");

  const event = await prisma.calendarEvent.create({
    data: {
      householdId: ctx.householdId,
      title: input.title,
      description: input.description,
      startTime,
      endTime,
      allDay: input.allDay,
      eventType: input.eventType,
      location: input.location,
      color: input.color,
      babies: {
        create: {
          baby: { connect: { id: input.babyId } }
        }
      }
    },
    include: { babies: true }
  });

  await writeAudit(ctx, {
    action: "calendar_event.create",
    entityType: "calendar_event",
    entityId: event.id,
    after: {
      id: event.id,
      title: event.title,
      babyId: input.babyId,
      startTime: event.startTime.toISOString(),
      endTime: event.endTime?.toISOString() ?? null
    }
  });

  return {
    id: event.id,
    babyId: input.babyId,
    date: input.startDate,
    month: input.startDate.slice(0, 7)
  };
}

function groupCounts(activities: Awaited<ReturnType<typeof prisma.activityLog.findMany>>) {
  return activities.reduce<Record<string, number>>((acc, activity) => {
    acc[activity.type] = (acc[activity.type] ?? 0) + 1;
    return acc;
  }, {});
}

function resolveEventEnd(input: z.infer<typeof calendarEventSchema>) {
  if (input.allDay) {
    return zonedDateStart(addDaysToDateKey(input.endDate ?? input.startDate, 1), env.APP_TIMEZONE);
  }
  if (!input.endTime) return undefined;
  return zonedDateTimeToDate(`${input.endDate ?? input.startDate}T${input.endTime}`, env.APP_TIMEZONE);
}

function resolveMonthKey(input: string | undefined) {
  if (isValidMonthKey(input)) return input;
  return dateKeyInTimeZone(new Date(), env.APP_TIMEZONE).slice(0, 7);
}

function isValidMonthKey(value: string | undefined): value is string {
  if (!value || !monthKeyPattern.test(value)) return false;
  const [year, month] = value.split("-").map(Number);
  return month >= 1 && month <= 12 && year >= 1900 && year <= 2200;
}

function isValidDateKey(value: string | undefined): value is string {
  if (!value || !dateKeyPattern.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function monthGridDateKeys(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const start = new Date(first);
  start.setUTCDate(first.getUTCDate() - first.getUTCDay());
  const days: string[] = [];
  for (let index = 0; index < 42; index += 1) {
    const next = new Date(start);
    next.setUTCDate(start.getUTCDate() + index);
    days.push(next.toISOString().slice(0, 10));
  }
  return days;
}

function addMonthsToMonthKey(monthKey: string, months: number) {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, 1));
  return date.toISOString().slice(0, 7);
}

function eventOverlapsDay(event: { startTime: Date; endTime: Date | null }, dayStart: Date, dayEnd: Date) {
  if (!event.endTime) return event.startTime >= dayStart && event.startTime < dayEnd;
  return event.startTime < dayEnd && event.endTime > dayStart;
}

function formatMonthLabel(monthKey: string) {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${monthKey}-01T12:00:00.000Z`)
  );
}

function formatDateKeyLabel(key: string) {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    keyToNoonDate(key)
  );
}

function keyToNoonDate(key: string) {
  return new Date(`${key}T12:00:00.000Z`);
}

function emptyToUndefined(value: string | undefined) {
  return value?.trim() || undefined;
}
