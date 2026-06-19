import { ActivityType, TimerState, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { durationSeconds } from "@/lib/dates";
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
  note: true
} satisfies Prisma.ActivityLogInclude;

type ActivityCreateDraft = Omit<Prisma.ActivityLogCreateInput, "household" | "baby" | "actorMember">;

function toDate(value: string | undefined, fallback?: Date) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
  return date;
}

function decimal(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value);
}

function specificCreate(input: ActivityCreateInput): ActivityCreateDraft {
  const occurredAt = toDate(input.occurredAt) ?? new Date();
  const startedAt = toDate(input.startedAt, occurredAt);
  const endedAt = input.type === "sleep" && input.activeTimer ? undefined : toDate(input.endedAt);
  const duration = startedAt && endedAt ? durationSeconds(startedAt, endedAt) : undefined;
  const timerState = input.type === "sleep" && input.activeTimer ? TimerState.running : TimerState.none;

  const base = {
    type: input.type as ActivityType,
    occurredAt,
    startedAt,
    endedAt,
    durationSeconds: duration,
    timezone: input.timezone,
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
            side: input.side
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
            rashConcern: input.rashConcern
          }
        }
      };
    case "sleep":
      return { ...base, sleep: { create: {} } };
    case "pumping":
      return {
        ...base,
        pumping: {
          create: {
            amount: decimal(input.amount),
            leftAmount: decimal(input.leftAmount),
            rightAmount: decimal(input.rightAmount),
            unit: input.unit
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
            headUnit: input.headUnit
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
  }
}

export async function createActivity(raw: unknown) {
  const ctx = await getHouseholdContext();
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
              { medicine: { name: { contains: params.search, mode: "insensitive" } } }
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
  return deleted;
}

export async function stopTimer(id: string) {
  const ctx = await getHouseholdContext();
  const activity = await getEditableActivity(ctx, id, "update");
  if (activity.timerState !== TimerState.running || !activity.startedAt) {
    throw new Error("not_found");
  }
  const endedAt = new Date();
  const updated = await prisma.activityLog.update({
    where: { id },
    data: {
      endedAt,
      occurredAt: activity.startedAt,
      durationSeconds: durationSeconds(activity.startedAt, endedAt),
      timerState: TimerState.stopped
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
