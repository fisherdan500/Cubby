import { BrowserOperationKey, type Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { addDaysToDateKey, dateKeyInTimeZone, zonedDateStart, zonedDateTimeToDate } from "@/lib/timezone";
import { getEffectiveHouseholdContext, requirePermission, type HouseholdContext } from "@/server/auth/context";
import { getHouseholdHome } from "@/server/services/households";
import { activityInclude } from "@/server/services/activities";
import { writeAudit } from "@/server/services/audit";
import { lockActorAndBabyForWrite } from "@/server/services/mutation-locks";
import {
  executeBrowserOperation,
  getBrowserOperationContextForBaby,
  issueBrowserOperation
} from "@/server/services/browser-operations";

const dateKeyPattern = /^\d{4}-\d{2}-\d{2}$/;
const monthKeyPattern = /^\d{4}-\d{2}$/;
const timePattern = /^\d{2}:\d{2}$/;

const contactIdsSchema = z.preprocess(
  (value) => Array.isArray(value) ? value : typeof value === "string" && value ? [value] : [],
  z.array(z.string().min(1).max(200)).max(50)
).transform((ids) => [...new Set(ids)].sort());

const calendarEventSchema = z.object({
  babyId: z.string().min(1),
  contactIds: contactIdsSchema,
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

const calendarEventOpeningSchema = z.object({
  babyId: z.string().min(1),
  contactIds: contactIdsSchema
});

const calendarEventOpeningSnapshotSchema = z.object({
  kind: z.literal("calendar-event-create"),
  schemaVersion: z.literal(1),
  baby: z.object({ id: z.string().min(1), revision: z.string().datetime() }),
  contacts: z.array(z.object({ id: z.string().min(1), revision: z.string().datetime() }))
});

export type CalendarEventCreateResult = {
  id: string;
  babyId: string;
  date: string;
  month: string;
};

type CalendarEventInput = z.infer<typeof calendarEventSchema>;
type CalendarEventOpeningInput = z.infer<typeof calendarEventOpeningSchema>;

function calendarEventTimes(input: CalendarEventInput) {
  const startTime = input.allDay
    ? zonedDateStart(input.startDate, env.APP_TIMEZONE)
    : zonedDateTimeToDate(`${input.startDate}T${input.startTime}`, env.APP_TIMEZONE);
  const endTime = resolveEventEnd(input);
  if (endTime && endTime <= startTime) throw new Error("invalid_date_range");
  return { startTime, endTime };
}

async function createCalendarEventInTransaction(
  tx: Prisma.TransactionClient,
  ctx: HouseholdContext,
  input: CalendarEventInput,
  startTime: Date,
  endTime: Date | undefined
) {
  const event = await tx.calendarEvent.create({
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
      babies: { create: { baby: { connect: { id: input.babyId } } } },
      contacts: input.contactIds.length
        ? { create: input.contactIds.map((contactId) => ({ contact: { connect: { id: contactId } } })) }
        : undefined
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
  }, tx);
  return { id: event.id, babyId: input.babyId, date: input.startDate, month: input.startDate.slice(0, 7) };
}

export async function issueCalendarEventBrowserOperation(raw: Record<string, unknown>) {
  const input = calendarEventOpeningSchema.parse(raw);
  const ctx = await getBrowserOperationContextForBaby(input.babyId);
  return issueBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.calendarEventCreate,
    opening: { babyId: input.babyId, contactIds: input.contactIds },
    babyId: input.babyId,
    targetKind: "calendar",
    permission: "activity.create",
    targetSnapshot: (tx, openingCtx, baby) => calendarEventOpeningSnapshot(tx, openingCtx, baby, input)
  });
}

export async function submitCalendarEventBrowserOperation(raw: Record<string, unknown>) {
  const input = calendarEventSchema.parse(raw);
  const { startTime, endTime } = calendarEventTimes(input);
  const ctx = await getBrowserOperationContextForBaby(input.babyId);
  return executeBrowserOperation({
    ctx,
    operationId: raw.operationId,
    operationKey: BrowserOperationKey.calendarEventCreate,
    intent: input,
    babyId: input.babyId,
    permission: "activity.create",
    validate: (tx, lockedCtx, baby, binding) =>
      assertCalendarEventOpeningCurrent(tx, lockedCtx, baby, binding.targetSnapshot, input),
    execute: async (tx, lockedCtx) => {
      const event = await createCalendarEventInTransaction(tx, lockedCtx, input, startTime, endTime);
      return { kind: "calendar_event", code: "ok", eventId: event.id };
    }
  });
}

async function calendarEventOpeningSnapshot(
  tx: Prisma.TransactionClient,
  ctx: HouseholdContext,
  baby: { id: string; updatedAt: Date },
  input: CalendarEventOpeningInput
) {
  const contacts = await currentCalendarContacts(tx, ctx.householdId, input.contactIds);
  return {
    kind: "calendar-event-create" as const,
    schemaVersion: 1 as const,
    baby: { id: baby.id, revision: baby.updatedAt.toISOString() },
    contacts: contacts.map((contact) => ({ id: contact.id, revision: contact.updatedAt.toISOString() }))
  };
}

async function assertCalendarEventOpeningCurrent(
  tx: Prisma.TransactionClient,
  ctx: HouseholdContext,
  baby: { id: string; updatedAt: Date },
  rawSnapshot: unknown,
  input: CalendarEventInput
) {
  const snapshot = calendarEventOpeningSnapshotSchema.safeParse(rawSnapshot);
  if (!snapshot.success || snapshot.data.baby.id !== input.babyId || snapshot.data.baby.revision !== baby.updatedAt.toISOString()) {
    throw new Error("stale_revision");
  }
  const expectedContactIds = snapshot.data.contacts.map((contact) => contact.id);
  if (expectedContactIds.length !== input.contactIds.length || expectedContactIds.some((id, index) => id !== input.contactIds[index])) {
    throw new Error("stale_revision");
  }
  const contacts = await currentCalendarContacts(tx, ctx.householdId, input.contactIds);
  if (contacts.some((contact, index) => contact.id !== snapshot.data.contacts[index]?.id || contact.updatedAt.toISOString() !== snapshot.data.contacts[index]?.revision)) {
    throw new Error("stale_revision");
  }
}

async function currentCalendarContacts(tx: Prisma.TransactionClient, householdId: string, contactIds: string[]) {
  for (const contactId of contactIds) {
    await tx.$queryRaw`SELECT "id" FROM "Contact" WHERE "id" = ${contactId} AND "householdId" = ${householdId} AND "deletedAt" IS NULL FOR UPDATE`;
  }
  const contacts = await tx.contact.findMany({
    where: { id: { in: contactIds }, householdId, deletedAt: null },
    select: { id: true, updatedAt: true },
    orderBy: { id: "asc" }
  });
  if (contacts.length !== contactIds.length) throw new Error("not_found");
  return contacts;
}

export async function getCalendar(
  userId: string,
  input?: { babyId?: string; month?: string; date?: string; eventId?: string }
) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");
  const home = await getHouseholdHome({ includeInactive: true });
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
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.create");
  const input = calendarEventSchema.parse(raw);
  const startTime = input.allDay
    ? zonedDateStart(input.startDate, env.APP_TIMEZONE)
    : zonedDateTimeToDate(`${input.startDate}T${input.startTime}`, env.APP_TIMEZONE);
  const endTime = resolveEventEnd(input);
  if (endTime && endTime <= startTime) throw new Error("invalid_date_range");

  return prisma.$transaction(async (tx) => {
    const { ctx: lockedCtx, baby } = await lockActorAndBabyForWrite(tx, ctx, input.babyId);
    requirePermission(lockedCtx, "activity.create");
    if (baby.inactiveAt) throw new Error("baby_inactive");

    const event = await tx.calendarEvent.create({
      data: {
        householdId: lockedCtx.householdId,
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
        },
        contacts: input.contactIds.length
          ? { create: input.contactIds.map((contactId) => ({ contact: { connect: { id: contactId } } })) }
          : undefined
      },
      include: { babies: true }
    });

    await writeAudit(lockedCtx, {
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
    }, tx);

    return {
      id: event.id,
      babyId: input.babyId,
      date: input.startDate,
      month: input.startDate.slice(0, 7)
    };
  });
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
