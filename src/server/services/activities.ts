import { ActivityType, TimerState, WebhookEvent, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { durationSeconds } from "@/lib/dates";
import { env } from "@/lib/env";
import { zonedDateTimeToDate } from "@/lib/timezone";
import { activityCreateSchema, activityUpdateSchema, type ActivityCreateInput } from "@/lib/validation/activity";
import { getHouseholdContext, requirePermission, type HouseholdContext } from "@/server/auth/context";
import { canMutateOwnOrAny } from "@/domain/roles";
import { writeAudit } from "@/server/services/audit";

export const activityInclude = {
  actorMember: { include: { user: true } },
  baby: true,
  feeding: true,
  diaper: true,
  sleep: true,
  pumping: true,
  medicine: true,
  measurement: true,
  milestone: true,
  note: true,
  bath: true,
  play: true,
  mood: true,
  supplement: true,
  vaccine: true,
  milkInventory: true
} satisfies Prisma.ActivityLogInclude;

type ActivityCreateDraft = Omit<Prisma.ActivityLogCreateInput, "household" | "baby" | "actorMember">;

function toDate(value: string | undefined, fallback?: Date) {
  if (!value) return fallback;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    return zonedDateTimeToDate(value, env.APP_TIMEZONE);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
  return date;
}

function decimal(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

const timerCapableTypes = new Set<ActivityType>([
  ActivityType.feeding,
  ActivityType.sleep,
  ActivityType.pumping,
  ActivityType.play
]);

function specificCreate(input: ActivityCreateInput): ActivityCreateDraft {
  const occurredAt = toDate(input.occurredAt) ?? new Date();
  const startedAt = toDate(input.startedAt, occurredAt);
  const isTimer = timerCapableTypes.has(input.type as ActivityType) && input.activeTimer;
  const endedAt = isTimer ? undefined : toDate(input.endedAt);
  const duration = startedAt && endedAt ? durationSeconds(startedAt, endedAt) : undefined;
  const timerState = isTimer ? TimerState.running : TimerState.none;

  const base = {
    type: input.type as ActivityType,
    occurredAt,
    startedAt,
    endedAt,
    durationSeconds: duration,
    timezone: env.APP_TIMEZONE,
    notes: input.notes,
    timerState
  };

  switch (input.type) {
    case "feeding":
      return {
        ...base,
        feeding: {
          create: {
            mode: input.mode,
            amount: decimal(input.amount),
            unit: input.unit,
            side: input.side,
            bottleType: input.bottleType,
            food: input.food,
            leftSeconds: input.leftSeconds ? Number(input.leftSeconds) : undefined,
            rightSeconds: input.rightSeconds ? Number(input.rightSeconds) : undefined
          }
        }
      };
    case "diaper":
      return {
        ...base,
        diaper: {
          create: {
            kind: input.kind,
            color: input.color,
            consistency: input.consistency,
            rashConcern: input.rashConcern,
            condition: input.condition,
            blowout: input.blowout,
            creamApplied: input.creamApplied
          }
        }
      };
    case "sleep":
      return {
        ...base,
        sleep: {
          create: {
            sleepType: input.sleepType,
            location: input.location,
            quality: input.quality
          }
        }
      };
    case "pumping":
      return {
        ...base,
        pumping: {
          create: {
            amount: decimal(input.amount),
            leftAmount: decimal(input.leftAmount),
            rightAmount: decimal(input.rightAmount),
            unit: input.unit,
            inventoryAction: input.inventoryAction
          }
        }
      };
    case "medicine":
      return {
        ...base,
        medicine: {
          create: {
            name: input.name,
            dose: decimal(input.dose),
            unit: input.unit,
            contactId: input.contactId
          }
        }
      };
    case "measurement":
      return {
        ...base,
        measurement: {
          create: {
            weight: decimal(input.weight),
            weightUnit: input.weightUnit,
            length: decimal(input.length),
            lengthUnit: input.lengthUnit,
            headCircumference: decimal(input.headCircumference),
            headUnit: input.headUnit,
            temperature: decimal(input.temperature),
            temperatureUnit: input.temperatureUnit,
            measurementType: input.measurementType
          }
        }
      };
    case "milestone":
      return {
        ...base,
        milestone: {
          create: {
            title: input.title,
            category: input.category
          }
        }
      };
    case "note":
      return {
        ...base,
        note: {
          create: {
            text: input.text,
            category: input.category
          }
        }
      };
    case "bath":
      return {
        ...base,
        bath: {
          create: {
            bathType: input.bathType,
            products: input.products,
            waterTemp: input.waterTemp
          }
        }
      };
    case "play":
      return {
        ...base,
        play: {
          create: {
            activityName: input.activityName,
            location: input.location,
            intensity: input.intensity
          }
        }
      };
    case "mood":
      return {
        ...base,
        mood: {
          create: {
            mood: input.mood,
            intensity: input.intensity ? Number(input.intensity) : undefined,
            context: input.context
          }
        }
      };
    case "supplement":
      return {
        ...base,
        supplement: {
          create: {
            name: input.name,
            dose: decimal(input.dose),
            unit: input.unit
          }
        }
      };
    case "vaccine":
      return {
        ...base,
        vaccine: {
          create: {
            name: input.name,
            dose: input.dose,
            lot: input.lot,
            provider: input.provider,
            dueDate: toDate(input.dueDate),
            documentUrl: input.documentUrl
          }
        }
      };
    case "milk_inventory":
      return {
        ...base,
        milkInventory: {
          create: {
            action: input.action,
            amount: decimal(input.amount),
            unit: input.unit,
            storage: input.storage,
            label: input.label
          }
        }
      };
  }
}

async function queueActivitySideEffects(ctx: HouseholdContext, activity: { id: string; type: ActivityType }, event: WebhookEvent) {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: {
      householdId: ctx.householdId,
      enabled: true,
      deletedAt: null,
      events: { has: event }
    },
    select: { id: true }
  });

  if (endpoints.length) {
    await prisma.webhookDelivery.createMany({
      data: endpoints.map((endpoint) => ({
        householdId: ctx.householdId,
        endpointId: endpoint.id,
        event,
        activityId: activity.id,
        payload: { activityId: activity.id, type: activity.type }
      }))
    });
  }

  if (event === WebhookEvent.activity_created) {
    const preferences = await prisma.notificationPreference.findMany({
      where: { householdId: ctx.householdId, activityCreated: true },
      select: { userId: true }
    });
    if (preferences.length) {
      await prisma.notificationLog.createMany({
        data: preferences.map((preference) => ({
          householdId: ctx.householdId,
          activityId: activity.id,
          userId: preference.userId,
          kind: "activity_created",
          title: "New Cubby activity",
          body: activity.type
        }))
      });
    }
  }
}

export async function createActivity(raw: unknown) {
  const ctx = await getHouseholdContext();
  return createActivityForContext(raw, ctx);
}

export async function createActivityForContext(raw: unknown, ctx: HouseholdContext) {
  requirePermission(ctx, "activity.create");
  const input = activityCreateSchema.parse(raw);
  const baby = await prisma.baby.findFirst({
    where: { id: input.babyId, householdId: ctx.householdId, deletedAt: null }
  });
  if (!baby) throw new Error("not_found");

  const activity = await prisma.activityLog.create({
    data: {
      ...specificCreate(input),
      household: { connect: { id: ctx.householdId } },
      baby: { connect: { id: input.babyId } },
      actorMember: { connect: { id: ctx.memberId } }
    },
    include: activityInclude
  });

  await writeAudit(ctx, {
    action: "activity.create",
    entityType: "activity",
    entityId: activity.id,
    after: activity
  });
  await queueActivitySideEffects(
    ctx,
    activity,
    activity.timerState === TimerState.running ? WebhookEvent.timer_started : WebhookEvent.activity_created
  );
  return activity;
}

export async function listActivities(params?: { babyId?: string; type?: string; search?: string }) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "activity.read");
  return prisma.activityLog.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      ...(params?.babyId ? { babyId: params.babyId } : {}),
      ...(params?.type ? { type: params.type as ActivityType } : {}),
      ...(params?.search
        ? {
            OR: [
              { notes: { contains: params.search, mode: "insensitive" } },
              { milestone: { title: { contains: params.search, mode: "insensitive" } } },
              { note: { text: { contains: params.search, mode: "insensitive" } } },
              { medicine: { name: { contains: params.search, mode: "insensitive" } } },
              { supplement: { name: { contains: params.search, mode: "insensitive" } } },
              { vaccine: { name: { contains: params.search, mode: "insensitive" } } },
              { mood: { mood: { contains: params.search, mode: "insensitive" } } },
              { play: { activityName: { contains: params.search, mode: "insensitive" } } }
            ]
          }
        : {})
    },
    include: activityInclude,
    orderBy: { occurredAt: "desc" },
    take: 100
  });
}

export async function getActivity(id: string) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "activity.read");
  const activity = await prisma.activityLog.findFirst({
    where: { id, householdId: ctx.householdId, deletedAt: null },
    include: activityInclude
  });
  if (!activity) throw new Error("not_found");
  return activity;
}

async function getEditableActivity(ctx: HouseholdContext, id: string, action: "update" | "delete") {
  const activity = await prisma.activityLog.findFirst({
    where: { id, householdId: ctx.householdId, deletedAt: null },
    include: activityInclude
  });
  if (!activity) throw new Error("not_found");
  if (!canMutateOwnOrAny(ctx.role, action, activity.actorMemberId === ctx.memberId)) {
    throw new Error("forbidden");
  }
  return activity;
}

async function replaceSpecificLog(tx: Prisma.TransactionClient, id: string, input: ActivityCreateInput) {
  await tx.feedingLog.deleteMany({ where: { activityId: id } });
  await tx.diaperLog.deleteMany({ where: { activityId: id } });
  await tx.sleepLog.deleteMany({ where: { activityId: id } });
  await tx.pumpingLog.deleteMany({ where: { activityId: id } });
  await tx.medicineLog.deleteMany({ where: { activityId: id } });
  await tx.measurementLog.deleteMany({ where: { activityId: id } });
  await tx.milestoneLog.deleteMany({ where: { activityId: id } });
  await tx.noteLog.deleteMany({ where: { activityId: id } });
  await tx.bathLog.deleteMany({ where: { activityId: id } });
  await tx.playLog.deleteMany({ where: { activityId: id } });
  await tx.moodLog.deleteMany({ where: { activityId: id } });
  await tx.supplementLog.deleteMany({ where: { activityId: id } });
  await tx.vaccineLog.deleteMany({ where: { activityId: id } });
  await tx.milkInventoryLog.deleteMany({ where: { activityId: id } });

  const data = specificCreate(input);
  const relation = data.feeding
    ? { feeding: data.feeding }
    : data.diaper
      ? { diaper: data.diaper }
      : data.sleep
        ? { sleep: data.sleep }
        : data.pumping
          ? { pumping: data.pumping }
          : data.medicine
            ? { medicine: data.medicine }
            : data.measurement
              ? { measurement: data.measurement }
              : data.milestone
                ? { milestone: data.milestone }
                : data.note
                  ? { note: data.note }
                  : data.bath
                    ? { bath: data.bath }
                    : data.play
                      ? { play: data.play }
                      : data.mood
                        ? { mood: data.mood }
                        : data.supplement
                          ? { supplement: data.supplement }
                          : data.vaccine
                            ? { vaccine: data.vaccine }
                            : data.milkInventory
                              ? { milkInventory: data.milkInventory }
                              : {};
  await tx.activityLog.update({ where: { id }, data: relation });
}

export async function updateActivity(id: string, raw: unknown) {
  const ctx = await getHouseholdContext();
  const input = activityUpdateSchema.parse({ ...(raw as object), id });
  const before = await getEditableActivity(ctx, id, "update");
  const next = specificCreate(input);
  const baby = await prisma.baby.findFirst({
    where: { id: input.babyId, householdId: ctx.householdId, deletedAt: null }
  });
  if (!baby) throw new Error("not_found");

  const updated = await prisma.$transaction(async (tx) => {
    await replaceSpecificLog(tx, id, input);
    return tx.activityLog.update({
      where: { id },
      data: {
        babyId: input.babyId,
        type: next.type,
        occurredAt: next.occurredAt,
        startedAt: next.startedAt,
        endedAt: next.endedAt,
        durationSeconds: next.durationSeconds,
        timezone: next.timezone,
        notes: next.notes,
        timerState: next.timerState
      },
      include: activityInclude
    });
  });

  await writeAudit(ctx, {
    action: "activity.update",
    entityType: "activity",
    entityId: updated.id,
    before,
    after: updated
  });
  await queueActivitySideEffects(ctx, updated, WebhookEvent.activity_updated);
  return updated;
}

export async function deleteActivity(id: string) {
  const ctx = await getHouseholdContext();
  const before = await getEditableActivity(ctx, id, "delete");
  const deleted = await prisma.activityLog.update({
    where: { id },
    data: { deletedAt: new Date(), deletedByMemberId: ctx.memberId },
    include: activityInclude
  });
  await writeAudit(ctx, {
    action: "activity.delete",
    entityType: "activity",
    entityId: id,
    before,
    after: deleted
  });
  await queueActivitySideEffects(ctx, deleted, WebhookEvent.activity_deleted);
  return deleted;
}

export async function stopTimer(id: string) {
  const ctx = await getHouseholdContext();
  const activity = await getEditableActivity(ctx, id, "update");
  if ((activity.timerState !== TimerState.running && activity.timerState !== TimerState.paused) || !activity.startedAt) {
    throw new Error("not_found");
  }
  const endedAt = new Date();
  const pausedSeconds =
    activity.pausedSeconds + (activity.pausedAt ? durationSeconds(activity.pausedAt, endedAt) : 0);
  const totalSeconds = Math.max(0, durationSeconds(activity.startedAt, endedAt) - pausedSeconds);
  const updated = await prisma.activityLog.update({
    where: { id },
    data: {
      endedAt,
      occurredAt: activity.startedAt,
      durationSeconds: totalSeconds,
      timerState: TimerState.stopped,
      pausedAt: null,
      pausedSeconds
    },
    include: activityInclude
  });
  await writeAudit(ctx, {
    action: "activity.timer.stop",
    entityType: "activity",
    entityId: id,
    before: activity,
    after: updated
  });
  await queueActivitySideEffects(ctx, updated, WebhookEvent.timer_stopped);
  return updated;
}

export async function pauseTimer(id: string) {
  const ctx = await getHouseholdContext();
  const activity = await getEditableActivity(ctx, id, "update");
  if (activity.timerState !== TimerState.running || !activity.startedAt) throw new Error("not_found");
  const updated = await prisma.activityLog.update({
    where: { id },
    data: { timerState: TimerState.paused, pausedAt: new Date() },
    include: activityInclude
  });
  await writeAudit(ctx, {
    action: "activity.timer.pause",
    entityType: "activity",
    entityId: id,
    before: activity,
    after: updated
  });
  return updated;
}

export async function resumeTimer(id: string) {
  const ctx = await getHouseholdContext();
  const activity = await getEditableActivity(ctx, id, "update");
  if (activity.timerState !== TimerState.paused || !activity.pausedAt) throw new Error("not_found");
  const updated = await prisma.activityLog.update({
    where: { id },
    data: {
      timerState: TimerState.running,
      pausedSeconds: activity.pausedSeconds + durationSeconds(activity.pausedAt, new Date()),
      pausedAt: null
    },
    include: activityInclude
  });
  await writeAudit(ctx, {
    action: "activity.timer.resume",
    entityType: "activity",
    entityId: id,
    before: activity,
    after: updated
  });
  return updated;
}

export async function undoLastActivity() {
  const ctx = await getHouseholdContext();
  const latest = await prisma.auditEvent.findFirst({
    where: {
      householdId: ctx.householdId,
      actorMemberId: ctx.memberId,
      entityType: "activity",
      action: { in: ["activity.create", "activity.delete"] }
    },
    orderBy: { createdAt: "desc" }
  });
  if (!latest) throw new Error("not_found");
  if (latest.action === "activity.create") {
    await prisma.activityLog.update({
      where: { id: latest.entityId },
      data: { deletedAt: new Date(), deletedByMemberId: ctx.memberId }
    });
  } else if (latest.action === "activity.delete") {
    await prisma.activityLog.update({
      where: { id: latest.entityId },
      data: { deletedAt: null, deletedByMemberId: null }
    });
  }
  await writeAudit(ctx, {
    action: "activity.undo",
    entityType: "activity",
    entityId: latest.entityId,
    before: latest.after ?? undefined,
    after: latest.before ?? undefined
  });
  return { id: latest.entityId };
}
