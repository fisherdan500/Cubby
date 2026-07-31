import { createHash, randomUUID } from "node:crypto";
import { ActivityType, TimerState, WebhookEvent, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { durationSeconds } from "@/lib/dates";
import { env } from "@/lib/env";
import { zonedDateTimeToDate } from "@/lib/timezone";
import { activityCreateSchema, activityUpdateSchema, type ActivityRestoreInput } from "@/lib/validation/activity";
import { getHouseholdContext, requirePermission, type HouseholdContext } from "@/server/auth/context";
import { canMutateOwnOrAny } from "@/domain/roles";
import { writeAudit } from "@/server/services/audit";
import { lockActorAndBabyForWrite, lockActorForWrite, lockApiKeyForWrite, lockBabyForWrite } from "@/server/services/mutation-locks";

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
type ActivityListPage = Pick<Prisma.ActivityLogFindManyArgs, "cursor" | "skip" | "take" | "orderBy">;

export function activityCreateFingerprint(input: { clientMutationId?: string; [key: string]: unknown }) {
  const { clientMutationId: _clientMutationId, ...payload } = input;
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function timerMutationInput(raw: unknown) {
  if (raw === undefined || raw === null) return { clientMutationId: randomUUID() };
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("validation_error");
  const clientMutationId = (raw as { clientMutationId?: unknown }).clientMutationId;
  if (clientMutationId === undefined) return { clientMutationId: randomUUID() };
  if (typeof clientMutationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientMutationId)) {
    throw new Error("validation_error");
  }
  return { clientMutationId };
}

function timerMutationFingerprint(operation: "timer.stop" | "timer.pause" | "timer.resume", activityId: string) {
  return createHash("sha256").update(JSON.stringify({ operation, activityId })).digest("hex");
}

function toDate(value: string | undefined, fallback?: Date) {
  if (!value) return fallback;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    return zonedDateTimeToDate(value, env.APP_TIMEZONE);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
  return date;
}

function auditActivityState(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const updatedAt = typeof value.updatedAt === "string" ? new Date(value.updatedAt) : null;
  const deletedAt = value.deletedAt === null ? null : typeof value.deletedAt === "string" ? new Date(value.deletedAt) : undefined;
  if (!updatedAt || Number.isNaN(updatedAt.getTime()) || deletedAt === undefined || (deletedAt && Number.isNaN(deletedAt.getTime()))) {
    return null;
  }
  return { updatedAt, deletedAt };
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

type HistoricalTimerMetadata = {
  timerState: typeof TimerState.stopped;
  durationSeconds: number;
  pausedSeconds: number;
};

type HistoricalActivityFields = {
  startedAt: Date | null;
  endedAt: Date | null;
  timezone: string;
};

function specificCreate(input: ActivityRestoreInput): ActivityCreateDraft {
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
            leftSeconds: input.leftSeconds,
            rightSeconds: input.rightSeconds
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

async function queueActivitySideEffects(
  ctx: HouseholdContext,
  activity: { id: string; type: ActivityType },
  event: WebhookEvent,
  db: Pick<Prisma.TransactionClient, "$queryRaw" | "webhookEndpoint" | "webhookDelivery" | "notificationPreference" | "notificationLog"> = prisma
) {
  const endpoints = await db.webhookEndpoint.findMany({
    where: {
      householdId: ctx.householdId,
      enabled: true,
      deletedAt: null,
      events: { has: event }
    },
    select: { id: true, legacyUnattributed: true, delegatedByMemberId: true },
    orderBy: { id: "asc" }
  });

  const lockedEndpoints: typeof endpoints = [];
  for (const endpoint of endpoints) {
    if (!endpoint.legacyUnattributed) {
      if (!endpoint.delegatedByMemberId) continue;
      const issuers = await db.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "HouseholdMember"
        WHERE "id" = ${endpoint.delegatedByMemberId}
          AND "householdId" = ${ctx.householdId}
          AND "disabledAt" IS NULL
          AND "deletedAt" IS NULL
        -- A concurrent closure owns this row exclusively; omit the outbox side effect
        -- rather than waiting behind the actor lock and forming an inverse lock cycle.
        FOR SHARE SKIP LOCKED
      `;
      if (!issuers.length) continue;
    }
    const rows = await db.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "WebhookEndpoint"
      WHERE "id" = ${endpoint.id}
        AND "householdId" = ${ctx.householdId}
        AND "enabled" = true
        AND "deletedAt" IS NULL
        AND "events" @> ARRAY[${event}]::"WebhookEvent"[]
      FOR UPDATE
    `;
    if (rows.length) lockedEndpoints.push(endpoint);
  }

  if (lockedEndpoints.length) {
    await db.webhookDelivery.createMany({
      data: lockedEndpoints.map((endpoint) => ({
        householdId: ctx.householdId,
        endpointId: endpoint.id,
        event,
        activityId: activity.id,
        payload: { activityId: activity.id, type: activity.type }
      }))
    });
  }

  if (event === WebhookEvent.activity_created) {
    const preferences = await db.notificationPreference.findMany({
      where: { householdId: ctx.householdId, activityCreated: true },
      select: { userId: true }
    });
    const activeRecipientUserIds = new Set<string>();
    for (const userId of [...new Set(preferences.map((preference) => preference.userId))].sort()) {
      const recipients = await db.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "HouseholdMember"
        WHERE "householdId" = ${ctx.householdId}
          AND "userId" = ${userId}
          AND "disabledAt" IS NULL
          AND "deletedAt" IS NULL
        -- A concurrent closure owns this row exclusively; omit the outbox side effect
        -- rather than waiting behind the actor lock and forming an inverse lock cycle.
        FOR SHARE SKIP LOCKED
      `;
      if (recipients.length) activeRecipientUserIds.add(userId);
    }
    const activePreferences = preferences.filter((preference) => activeRecipientUserIds.has(preference.userId));
    if (activePreferences.length) {
      await db.notificationLog.createMany({
        data: activePreferences.map((preference) => ({
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

async function requireHouseholdMedicineContact(
  tx: Pick<Prisma.TransactionClient, "contact">,
  ctx: HouseholdContext,
  input: ActivityRestoreInput
) {
  if (input.type !== "medicine" || !input.contactId) return;
  const contact = await tx.contact.findFirst({
    where: { id: input.contactId, householdId: ctx.householdId, deletedAt: null },
    select: { id: true }
  });
  if (!contact) throw new Error("not_found");
}

export async function createActivityForContext(raw: unknown, ctx: HouseholdContext & { apiKeyId?: string; scopes?: string[] }) {
  requirePermission(ctx, "activity.create");
  const input = activityCreateSchema.parse(raw);
  const fingerprint = activityCreateFingerprint(input);

  try {
    return await prisma.$transaction(async (tx) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    if ("apiKeyId" in ctx && typeof ctx.apiKeyId === "string") {
      const key = await lockApiKeyForWrite(tx, lockedCtx, ctx.apiKeyId);
      if (!key.scopes.includes("write") && !key.scopes.includes("*")) throw new Error("forbidden");
    }
    requirePermission(lockedCtx, "activity.create");
    const existing = await tx.activityLog.findFirst({
      where: { householdId: lockedCtx.householdId, clientMutationId: input.clientMutationId },
      include: activityInclude
    });
    if (existing) {
      if (existing.actorMemberId !== lockedCtx.memberId || existing.clientMutationFingerprint !== fingerprint) {
        throw new Error("idempotency_conflict");
      }
      return existing;
    }
    const baby = await lockBabyForWrite(tx, lockedCtx, input.babyId);
    if (baby.inactiveAt) throw new Error("baby_inactive");
    return createActivityInTransaction(input, lockedCtx, tx, true, undefined, undefined, true, undefined, fingerprint);
    });
  } catch (error) {
    if (
      !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002" &&
        "meta" in error &&
        typeof error.meta === "object" &&
        error.meta !== null &&
        "target" in error.meta &&
        Array.isArray(error.meta.target) &&
        error.meta.target.includes("householdId") &&
        error.meta.target.includes("clientMutationId")
      )
    ) throw error;
    return prisma.$transaction(async (tx) => {
      const lockedCtx = await lockActorForWrite(tx, ctx);
      if ("apiKeyId" in ctx && typeof ctx.apiKeyId === "string") {
        const key = await lockApiKeyForWrite(tx, lockedCtx, ctx.apiKeyId);
        if (!key.scopes.includes("write") && !key.scopes.includes("*")) throw new Error("forbidden");
      }
      requirePermission(lockedCtx, "activity.create");
      const existing = await tx.activityLog.findFirst({
        where: { householdId: lockedCtx.householdId, clientMutationId: input.clientMutationId },
        include: activityInclude
      });
      if (!existing || existing.actorMemberId !== lockedCtx.memberId || existing.clientMutationFingerprint !== fingerprint) {
        throw new Error("idempotency_conflict");
      }
      return existing;
    });
  }
}

async function createActivityInTransaction(
  input: ActivityRestoreInput,
  ctx: HouseholdContext,
  tx: Prisma.TransactionClient,
  queueSideEffects: boolean,
  historicalTimer?: HistoricalTimerMetadata,
  historicalAttribution?: { source: string; externalActorName: string | null },
  writeActivityAudit = true,
  historicalFields?: HistoricalActivityFields,
  clientMutationFingerprint?: string
) {
  await requireHouseholdMedicineContact(tx, ctx, input);
  const activity = await tx.activityLog.create({
    data: {
      ...specificCreate(input),
      ...(historicalTimer
        ? {
            timerState: historicalTimer.timerState,
            durationSeconds: historicalTimer.durationSeconds,
            pausedAt: null,
            pausedSeconds: historicalTimer.pausedSeconds
          }
        : {}),
      ...(historicalAttribution ?? {}),
      ...(historicalFields ?? {}),
      clientMutationId: input.clientMutationId,
      clientMutationFingerprint,
      household: { connect: { id: ctx.householdId } },
      baby: { connect: { id: input.babyId } },
      actorMember: { connect: { id: ctx.memberId } }
    },
    include: activityInclude
  });

  if (writeActivityAudit) {
    await writeAudit(ctx, { action: "activity.create", entityType: "activity", entityId: activity.id, after: activity }, tx);
  }
  if (queueSideEffects) {
    await queueActivitySideEffects(
      ctx,
      activity,
      activity.timerState === TimerState.running ? WebhookEvent.timer_started : WebhookEvent.activity_created,
      tx
    );
  }
  return activity;
}

export async function restoreHistoricalActivityForContext(
  input: ActivityRestoreInput,
  lockedCtx: HouseholdContext,
  tx: Prisma.TransactionClient,
  historicalTimer?: HistoricalTimerMetadata,
  historicalAttribution?: { source: string; externalActorName: string | null },
  historicalFields?: HistoricalActivityFields
) {
  requirePermission(lockedCtx, "backup.manage");
  if (input.activeTimer) throw new Error("backup_active_timer");
  if (historicalTimer && !timerCapableTypes.has(input.type as ActivityType)) throw new Error("backup_invalid_timer");
  return createActivityInTransaction(
    { ...input, clientMutationId: undefined },
    lockedCtx,
    tx,
    false,
    historicalTimer,
    historicalAttribution,
    false,
    historicalFields
  );
}

export async function listActivities(params?: {
  babyId?: string;
  type?: string;
  search?: string;
  page?: ActivityListPage;
}) {
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
    ...(params?.page ?? {
      orderBy: [{ occurredAt: "desc" as const }, { id: "desc" as const }],
      take: 100
    })
  });
}

export async function getActivityView(id: string) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "activity.read");
  const activity = await prisma.activityLog.findFirst({
    where: { id, householdId: ctx.householdId, deletedAt: null },
    include: activityInclude
  });
  if (!activity) throw new Error("not_found");
  const isOwn = activity.actorMemberId === ctx.memberId;
  return {
    activity,
    canUpdate: canMutateOwnOrAny(ctx.role, "update", isOwn),
    canDelete: canMutateOwnOrAny(ctx.role, "delete", isOwn)
  };
}

export async function getActivityForEdit(id: string) {
  const view = await getActivityView(id);
  if (!view.canUpdate) throw new Error("forbidden");
  return view.activity;
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

async function updateCurrentActivity(
  ctx: HouseholdContext,
  activity: { id: string; babyId: string; actorMemberId: string; updatedAt: Date },
  data: Prisma.ActivityLogUpdateManyMutationInput,
  action: string,
  permissionAction: "update" | "delete",
  event?: WebhookEvent
) {
  return prisma.$transaction(async (tx) => {
    const { ctx: lockedCtx } = await lockActorAndBabyForWrite(tx, ctx, activity.babyId);
    if (!canMutateOwnOrAny(lockedCtx.role, permissionAction, activity.actorMemberId === lockedCtx.memberId)) {
      throw new Error("forbidden");
    }
    const claimed = await tx.activityLog.updateMany({
      where: {
        id: activity.id,
        householdId: ctx.householdId,
        deletedAt: null,
        updatedAt: activity.updatedAt
      },
      data
    });
    if (claimed.count !== 1) throw new Error("stale_revision");
    const updated = await tx.activityLog.findUniqueOrThrow({ where: { id: activity.id }, include: activityInclude });
    await writeAudit(
      lockedCtx,
      { action, entityType: "activity", entityId: activity.id, before: activity, after: updated },
      tx
    );
    if (event) await queueActivitySideEffects(lockedCtx, updated, event, tx);
    return updated;
  });
}

async function replaceSpecificLog(
  tx: Prisma.TransactionClient,
  id: string,
  input: ActivityRestoreInput,
  medicineContactId?: string | null
) {
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
  if (input.type !== "vaccine") await tx.vaccineLog.deleteMany({ where: { activityId: id } });
  await tx.milkInventoryLog.deleteMany({ where: { activityId: id } });

  if (input.type === "vaccine") {
    const vaccine = {
      name: input.name,
      dose: input.dose,
      lot: input.lot,
      provider: input.provider,
      dueDate: toDate(input.dueDate),
      documentUrl: input.documentUrl
    };
    await tx.vaccineLog.upsert({
      where: { activityId: id },
      create: { activityId: id, ...vaccine },
      update: {
        name: vaccine.name,
        dose: vaccine.dose ?? null,
        lot: vaccine.lot ?? null,
        provider: vaccine.provider ?? null,
        dueDate: vaccine.dueDate ?? null,
        documentUrl: vaccine.documentUrl ?? null
      }
    });
    return;
  }

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
  if (data.medicine && medicineContactId) {
    await tx.medicineLog.update({ where: { activityId: id }, data: { contactId: medicineContactId } });
  }
}

export async function updateActivity(id: string, raw: unknown) {
  const ctx = await getHouseholdContext();
  const medicineContactWasProvided =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, "contactId");
  const input = activityUpdateSchema.parse({ ...(raw as object), id });
  const before = await getEditableActivity(ctx, id, "update");
  const next = specificCreate(input);
  if (before.timerState !== TimerState.none && input.type !== before.type) throw new Error("not_found");
  const expectedUpdatedAt = toDate(input.expectedUpdatedAt) ?? before.updatedAt;
  const activeTimer = before.timerState === TimerState.running || before.timerState === TimerState.paused;
  const editedTimerState = before.timerState === TimerState.none ? next.timerState : before.timerState;
  const updated = await prisma.$transaction(async (tx) => {
    const { ctx: lockedCtx, baby } = await lockActorAndBabyForWrite(tx, ctx, input.babyId);
    if (!canMutateOwnOrAny(lockedCtx.role, "update", before.actorMemberId === lockedCtx.memberId)) {
      throw new Error("forbidden");
    }
    const startsTimer = before.timerState === TimerState.none && next.timerState === TimerState.running;
    if (baby.inactiveAt && (input.babyId !== before.babyId || startsTimer || activeTimer)) {
      throw new Error("baby_inactive");
    }
    if (input.type === "medicine" && medicineContactWasProvided && input.contactId) {
      await requireHouseholdMedicineContact(tx, lockedCtx, input);
    }
    const claimed = await tx.activityLog.updateMany({
      where: { id, householdId: ctx.householdId, deletedAt: null, updatedAt: expectedUpdatedAt },
      data: {
        babyId: input.babyId,
        type: next.type,
        occurredAt: next.occurredAt,
        startedAt: activeTimer ? before.startedAt : next.startedAt,
        endedAt: activeTimer ? before.endedAt : next.endedAt,
        durationSeconds: activeTimer ? before.durationSeconds : next.durationSeconds,
        timezone: next.timezone,
        notes: next.notes,
        timerState: editedTimerState
      }
    });
    if (claimed.count !== 1) throw new Error("not_found");
    await replaceSpecificLog(tx, id, input, medicineContactWasProvided ? undefined : before.medicine?.contactId);
    const updated = await tx.activityLog.findUniqueOrThrow({ where: { id }, include: activityInclude });
    await writeAudit(
      lockedCtx,
      { action: "activity.update", entityType: "activity", entityId: updated.id, before, after: updated },
      tx
    );
    await queueActivitySideEffects(lockedCtx, updated, WebhookEvent.activity_updated, tx);
    return updated;
  });
  return updated;
}

export async function deleteActivity(id: string) {
  const ctx = await getHouseholdContext();
  const before = await getEditableActivity(ctx, id, "delete");
  const deleted = await updateCurrentActivity(
    ctx,
    before,
    { deletedAt: new Date(), deletedByMemberId: ctx.memberId },
    "activity.delete",
    "delete",
    WebhookEvent.activity_deleted
  );
  return deleted;
}

function isMutationReceiptUniqueError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  return candidate.code === "P2002" && Array.isArray(candidate.meta?.target) && candidate.meta.target.length === 2 && candidate.meta.target[0] === "householdId" && candidate.meta.target[1] === "clientMutationId";
}

async function findTimerReplay(
  id: string,
  mutation: ReturnType<typeof timerMutationInput>,
  operation: "timer.stop" | "timer.pause" | "timer.resume"
) {
  const ctx = await getHouseholdContext();
  const fingerprint = timerMutationFingerprint(operation, id);
  return prisma.$transaction(async (tx) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    const receipt = await tx.mutationReceipt.findFirst({ where: { householdId: lockedCtx.householdId, clientMutationId: mutation.clientMutationId } });
    if (!receipt) return null;
    if (receipt.actorMemberId !== lockedCtx.memberId || receipt.operation !== operation || receipt.targetActivityId !== id || receipt.intentFingerprint !== fingerprint) {
      throw new Error("idempotency_conflict");
    }
    const outcome = await tx.activityLog.findFirst({ where: { id: receipt.outcomeActivityId, householdId: lockedCtx.householdId, deletedAt: null }, include: activityInclude });
    if (!outcome) throw new Error("not_found");
    await lockBabyForWrite(tx, lockedCtx, outcome.babyId);
    if (!canMutateOwnOrAny(lockedCtx.role, "update", outcome.actorMemberId === lockedCtx.memberId)) throw new Error("forbidden");
    return outcome;
  });
}

export async function stopTimer(id: string, raw?: unknown, recoveringReceiptRace = false) {
  const mutation = timerMutationInput(raw);
  const replay = await findTimerReplay(id, mutation, "timer.stop");
  if (replay) return replay;
  const ctx = await getHouseholdContext();
  const activity = await getEditableActivity(ctx, id, "update");
  if ((activity.timerState !== TimerState.running && activity.timerState !== TimerState.paused) || !activity.startedAt) {
    throw new Error("not_found");
  }
  const endedAt = new Date();
  const pausedSeconds =
    activity.pausedSeconds + (activity.pausedAt ? durationSeconds(activity.pausedAt, endedAt) : 0);
  const totalSeconds = Math.max(0, durationSeconds(activity.startedAt, endedAt) - pausedSeconds);
  try {
    return await prisma.$transaction(async (tx) => {
    const { ctx: lockedCtx } = await lockActorAndBabyForWrite(tx, ctx, activity.babyId);
    if (!canMutateOwnOrAny(lockedCtx.role, "update", activity.actorMemberId === lockedCtx.memberId)) throw new Error("forbidden");
    const claimed = await tx.activityLog.updateMany({
      where: { id: activity.id, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: activity.updatedAt },
      data: { endedAt, occurredAt: activity.startedAt!, durationSeconds: totalSeconds, timerState: TimerState.stopped, pausedAt: null, pausedSeconds }
    });
    if (claimed.count !== 1) throw new Error("stale_revision");
    const updated = await tx.activityLog.findUniqueOrThrow({ where: { id: activity.id }, include: activityInclude });
    await tx.mutationReceipt.create({
      data: {
        householdId: lockedCtx.householdId,
        actorMemberId: lockedCtx.memberId,
        apiKeyId: null,
        operation: "timer.stop",
        targetActivityId: activity.id,
        clientMutationId: mutation.clientMutationId,
        intentFingerprint: timerMutationFingerprint("timer.stop", activity.id),
        outcomeActivityId: updated.id
      }
    });
    await writeAudit(lockedCtx, { action: "activity.timer.stop", entityType: "activity", entityId: activity.id, before: activity, after: updated }, tx);
    await queueActivitySideEffects(lockedCtx, updated, WebhookEvent.timer_stopped, tx);
    return updated;
    });
  } catch (error) {
    if (!recoveringReceiptRace && (isMutationReceiptUniqueError(error) || (error instanceof Error && error.message === "stale_revision"))) {
      const recovered = await findTimerReplay(id, mutation, "timer.stop");
      if (recovered) return recovered;
    }
    throw error;
  }
}

export async function pauseTimer(id: string, raw?: unknown, recoveringReceiptRace = false) {
  const mutation = timerMutationInput(raw);
  const replay = await findTimerReplay(id, mutation, "timer.pause");
  if (replay) return replay;
  const ctx = await getHouseholdContext();
  const activity = await getEditableActivity(ctx, id, "update");
  if (activity.timerState !== TimerState.running || !activity.startedAt) throw new Error("not_found");
  try {
    return await prisma.$transaction(async (tx) => {
      const { ctx: lockedCtx } = await lockActorAndBabyForWrite(tx, ctx, activity.babyId);
      if (!canMutateOwnOrAny(lockedCtx.role, "update", activity.actorMemberId === lockedCtx.memberId)) throw new Error("forbidden");
      const claimed = await tx.activityLog.updateMany({
        where: { id: activity.id, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: activity.updatedAt, timerState: TimerState.running },
        data: { timerState: TimerState.paused, pausedAt: new Date() }
      });
      if (claimed.count !== 1) throw new Error("stale_revision");
      const updated = await tx.activityLog.findUniqueOrThrow({ where: { id: activity.id }, include: activityInclude });
      await tx.mutationReceipt.create({
        data: {
          householdId: lockedCtx.householdId,
          actorMemberId: lockedCtx.memberId,
          apiKeyId: null,
          operation: "timer.pause",
          targetActivityId: activity.id,
          clientMutationId: mutation.clientMutationId,
          intentFingerprint: timerMutationFingerprint("timer.pause", activity.id),
          outcomeActivityId: updated.id
        }
      });
      await writeAudit(lockedCtx, { action: "activity.timer.pause", entityType: "activity", entityId: activity.id, before: activity, after: updated }, tx);
      return updated;
    });
  } catch (error) {
    if (!recoveringReceiptRace && (isMutationReceiptUniqueError(error) || (error instanceof Error && error.message === "stale_revision"))) {
      const recovered = await findTimerReplay(id, mutation, "timer.pause");
      if (recovered) return recovered;
    }
    throw error;
  }
}

export async function resumeTimer(id: string, raw?: unknown, recoveringReceiptRace = false) {
  const mutation = timerMutationInput(raw);
  const replay = await findTimerReplay(id, mutation, "timer.resume");
  if (replay) return replay;
  const ctx = await getHouseholdContext();
  const activity = await getEditableActivity(ctx, id, "update");
  if (activity.timerState !== TimerState.paused || !activity.pausedAt) throw new Error("not_found");
  try {
    return await prisma.$transaction(async (tx) => {
      const { ctx: lockedCtx, baby } = await lockActorAndBabyForWrite(tx, ctx, activity.babyId);
      if (!canMutateOwnOrAny(lockedCtx.role, "update", activity.actorMemberId === lockedCtx.memberId)) throw new Error("forbidden");
      if (baby.inactiveAt) throw new Error("baby_inactive");
      const claimed = await tx.activityLog.updateMany({
        where: { id: activity.id, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: activity.updatedAt, timerState: TimerState.paused },
        data: { timerState: TimerState.running, pausedSeconds: activity.pausedSeconds + durationSeconds(activity.pausedAt!, new Date()), pausedAt: null }
      });
      if (claimed.count !== 1) throw new Error("stale_revision");
      const updated = await tx.activityLog.findUniqueOrThrow({ where: { id: activity.id }, include: activityInclude });
      await tx.mutationReceipt.create({
        data: { householdId: lockedCtx.householdId, actorMemberId: lockedCtx.memberId, apiKeyId: null, operation: "timer.resume", targetActivityId: activity.id, clientMutationId: mutation.clientMutationId, intentFingerprint: timerMutationFingerprint("timer.resume", activity.id), outcomeActivityId: updated.id }
      });
      await writeAudit(lockedCtx, { action: "activity.timer.resume", entityType: "activity", entityId: activity.id, before: activity, after: updated }, tx);
      return updated;
    });
  } catch (error) {
    if (!recoveringReceiptRace && (isMutationReceiptUniqueError(error) || (error instanceof Error && error.message === "stale_revision"))) {
      const recovered = await findTimerReplay(id, mutation, "timer.resume");
      if (recovered) return recovered;
    }
    throw error;
  }
}

export async function undoLastActivity() {
  const ctx = await getHouseholdContext();
  return prisma.$transaction(async (tx) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    const latest = await tx.auditEvent.findFirst({
      where: {
        householdId: lockedCtx.householdId,
        actorMemberId: lockedCtx.memberId,
        entityType: "activity",
        action: { in: ["activity.create", "activity.delete"] }
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
    if (!latest) throw new Error("not_found");

    const target = await tx.activityLog.findFirst({
      where: { id: latest.entityId, householdId: lockedCtx.householdId },
      select: { babyId: true }
    });
    if (!target) throw new Error("not_found");
    const baby = await lockBabyForWrite(tx, lockedCtx, target.babyId);

    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "ActivityLog"
      WHERE "id" = ${latest.entityId} AND "householdId" = ${lockedCtx.householdId}
      FOR UPDATE
    `;
    if (locked.length !== 1) throw new Error("not_found");

    const superseding = await tx.auditEvent.findFirst({
      where: {
        householdId: lockedCtx.householdId,
        entityType: "activity",
        entityId: latest.entityId,
        createdAt: { gte: latest.createdAt },
        id: { not: latest.id }
      },
      select: { id: true }
    });
    if (superseding) throw new Error("not_found");

    const undoCreate = latest.action === "activity.create";
    const expected = auditActivityState(latest.after);
    if (!expected || (undoCreate ? expected.deletedAt !== null : expected.deletedAt === null)) throw new Error("not_found");
    const before = await tx.activityLog.findFirst({
      where: {
        id: latest.entityId,
        householdId: lockedCtx.householdId,
        deletedAt: expected.deletedAt,
        updatedAt: expected.updatedAt
      },
      include: activityInclude
    });
    if (!before) throw new Error("not_found");
    if (!canMutateOwnOrAny(lockedCtx.role, undoCreate ? "delete" : "update", before.actorMemberId === lockedCtx.memberId)) {
      throw new Error("forbidden");
    }
    const restoresActiveTimer = !undoCreate && (before.timerState === TimerState.running || before.timerState === TimerState.paused);
    if (restoresActiveTimer && baby.inactiveAt) throw new Error("baby_inactive");

    const claimed = await tx.activityLog.updateMany({
      where: {
        id: before.id,
        householdId: lockedCtx.householdId,
        deletedAt: before.deletedAt,
        updatedAt: before.updatedAt
      },
      data: undoCreate
        ? { deletedAt: new Date(), deletedByMemberId: lockedCtx.memberId }
        : { deletedAt: null, deletedByMemberId: null }
    });
    if (claimed.count !== 1) throw new Error("not_found");
    const after = await tx.activityLog.findUniqueOrThrow({ where: { id: before.id }, include: activityInclude });
    await writeAudit(
      lockedCtx,
      { action: "activity.undo", entityType: "activity", entityId: before.id, before, after },
      tx
    );
    return { id: before.id };
  });
}
