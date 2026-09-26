import { createHash, randomUUID } from "node:crypto";
import { ActivityType, BrowserOperationKey, FeedingKind, TimerState, WebhookEvent, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { durationSeconds } from "@/lib/dates";
import { env } from "@/lib/env";
import { zonedDateTimeToDate } from "@/lib/timezone";
import {
  activityBrowserCreateSchema,
  activityBrowserUpdateSchema,
  activityCreateSchema,
  activityUpdateSchema,
  type ActivityRestoreInput
} from "@/lib/validation/activity";
import { getEffectiveHouseholdContext, requirePermission, type HouseholdContext } from "@/server/auth/context";
import type { LastFeeding } from "@/domain/feeding-defaults";
import { canMutateOwnOrAny } from "@/domain/roles";
import type { ActivityRowViewer } from "@/lib/activity-row-actions";
import { writeAudit } from "@/server/services/audit";
import { lockActorAndBabyForWrite, lockActorForWrite, lockApiKeyForWrite, lockBabyForWrite } from "@/server/services/mutation-locks";
import {
  executeBrowserOperation,
  executeHouseholdBrowserOperation,
  getBrowserOperationContextForBaby,
  getBrowserOperationContextForHousehold,
  issueBrowserOperation,
  issueHouseholdBrowserOperation,
  type BrowserOperationResult
} from "@/server/services/browser-operations";

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

function activityUndoFingerprint(activityId: string, permissionAction: "delete" | "update") {
  return createHash("sha256")
    .update(JSON.stringify({ operation: "activity.undo", activityId, permissionAction }))
    .digest("hex");
}

function activityDeleteFingerprint(activityId: string) {
  return createHash("sha256").update(JSON.stringify({ operation: "activity.delete", activityId })).digest("hex");
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
  pauseTrackingStartedAt?: Date | null;
  pauseTrackingBaselineSeconds?: number | null;
  pauseIntervals?: Array<{ startedAt: Date; endedAt: Date }>;
};

function requireValidHistoricalPauseIntervals(
  historicalTimer: HistoricalTimerMetadata | undefined,
  historicalFields: HistoricalActivityFields | undefined
) {
  const pauseIntervals = historicalFields?.pauseIntervals ?? [];
  const trackingBoundary = historicalFields?.pauseTrackingStartedAt ?? null;
  const trackingBaselineSeconds = historicalFields?.pauseTrackingBaselineSeconds ?? null;
  if (historicalTimer?.timerState !== TimerState.stopped) {
    if (trackingBoundary !== null || trackingBaselineSeconds !== null || pauseIntervals.length > 0) {
      throw new Error("backup_invalid_pause_intervals");
    }
    return;
  }
  const activityStart = historicalFields?.startedAt?.getTime();
  const activityEnd = historicalFields?.endedAt?.getTime();
  const trackingStart = trackingBoundary?.getTime();
  if (trackingStart === undefined) {
    if (trackingBaselineSeconds !== null || pauseIntervals.length > 0) {
      throw new Error("backup_invalid_pause_intervals");
    }
    return;
  }
  if (
    activityStart === undefined ||
    activityEnd === undefined ||
    trackingBaselineSeconds === null ||
    trackingBaselineSeconds < 0 ||
    trackingBaselineSeconds > historicalTimer.pausedSeconds
  ) {
    throw new Error("backup_invalid_pause_intervals");
  }
  if (trackingStart < activityStart || trackingStart > activityEnd) throw new Error("backup_invalid_pause_intervals");
  let previousEnd = activityStart;
  let closedPauseSeconds = 0;
  for (const pause of pauseIntervals) {
    const pauseStart = pause.startedAt.getTime();
    const pauseEnd = pause.endedAt.getTime();
    if (
      pauseStart < activityStart ||
      pauseEnd > activityEnd ||
      pauseEnd < pauseStart ||
      pauseEnd < trackingStart ||
      pauseStart < previousEnd
    ) {
      throw new Error("backup_invalid_pause_intervals");
    }
    closedPauseSeconds += durationSeconds(pause.startedAt, pause.endedAt);
    previousEnd = pauseEnd;
  }
  if (closedPauseSeconds !== historicalTimer.pausedSeconds - trackingBaselineSeconds) {
    throw new Error("backup_invalid_pause_intervals");
  }
}

function auditActivityPayload(activity: {
  type: string;
  timerState: string;
  source?: string | null;
  deletedAt?: Date | null;
  updatedAt?: Date | null;
}) {
  return {
    type: activity.type,
    timerState: activity.timerState,
    ...(activity.source ? { source: activity.source } : {}),
    // auditActivityState requires this and returns null without it, which made undo-last reject
    // every activity as an unknown revision.
    ...(activity.updatedAt ? { updatedAt: activity.updatedAt.toISOString() } : {}),
    deletedAt: activity.deletedAt?.toISOString() ?? null
  };
}

export function specificCreate(input: ActivityRestoreInput): ActivityCreateDraft {
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
    timerState,
    pauseTrackingStartedAt: isTimer ? startedAt : undefined,
    pauseTrackingBaselineSeconds: isTimer ? 0 : undefined
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
  activity: { id: string; babyId: string; type: ActivityType },
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
      where: {
        householdId: ctx.householdId,
        status: "active",
        externalDeliveryEnabled: true,
        categories: { has: "activity_created" },
        channels: { has: "browser_push" },
        OR: [
          { babyScope: "all" },
          { babyScope: "selected", selectedBabies: { some: { babyId: activity.babyId } } }
        ],
        member: { is: { householdId: ctx.householdId, disabledAt: null, deletedAt: null } }
      },
      select: { memberId: true }
    });
    const activeRecipientUserIds = new Set<string>();
    for (const preference of [...preferences].sort((left, right) => left.memberId.localeCompare(right.memberId))) {
      const recipients = await db.$queryRaw<Array<{ userId: string }>>`
        SELECT "userId"
        FROM "HouseholdMember"
        WHERE "id" = ${preference.memberId}
          AND "householdId" = ${ctx.householdId}
          AND "disabledAt" IS NULL
          AND "deletedAt" IS NULL
        -- A concurrent closure owns this row exclusively; omit the outbox side effect
        -- rather than waiting behind the actor lock and forming an inverse lock cycle.
        FOR SHARE SKIP LOCKED
      `;
      if (recipients.length) activeRecipientUserIds.add(recipients[0]!.userId);
    }
    if (activeRecipientUserIds.size) {
      await db.notificationLog.createMany({
        data: [...activeRecipientUserIds].sort().map((userId) => ({
          householdId: ctx.householdId,
          activityId: activity.id,
          userId,
          kind: "activity_created",
          title: "New Cubby activity",
          body: activity.type
        }))
      });
    }
  }
}

export async function createActivity(raw: unknown) {
  const ctx = await getEffectiveHouseholdContext();
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

  const replayOrCreate = async (tx: Prisma.TransactionClient, recoverOnly = false) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    if ("apiKeyId" in ctx && typeof ctx.apiKeyId === "string") {
      const key = await lockApiKeyForWrite(tx, lockedCtx, ctx.apiKeyId);
      if (!key.scopes.includes("write") && !key.scopes.includes("*")) throw new Error("forbidden");
    }
    requirePermission(lockedCtx, "activity.create");
    const receipt = await tx.mutationReceipt.findFirst({
      where: { householdId: lockedCtx.householdId, clientMutationId: input.clientMutationId }
    });
    if (receipt) {
      if (
        receipt.actorMemberId !== lockedCtx.memberId ||
        receipt.operation !== "activity.create" ||
        receipt.targetActivityId !== receipt.outcomeActivityId ||
        receipt.intentFingerprint !== fingerprint
      ) throw new Error("idempotency_conflict");
      const snapshot = receiptOutcomeSnapshot(receipt);
      if (!snapshot) throw new Error("idempotency_conflict");
      return snapshot;
    }
    const legacy = await tx.activityLog.findFirst({
      where: { householdId: lockedCtx.householdId, clientMutationId: input.clientMutationId },
      include: activityInclude
    });
    if (legacy) {
      if (legacy.actorMemberId !== lockedCtx.memberId || legacy.clientMutationFingerprint !== fingerprint) throw new Error("idempotency_conflict");
      return legacy;
    }
    if (recoverOnly) throw new Error("idempotency_conflict");
    const baby = await lockBabyForWrite(tx, lockedCtx, input.babyId);
    if (baby.inactiveAt) throw new Error("baby_inactive");
    const activity = await createActivityInTransaction(input, lockedCtx, tx, true, undefined, undefined, true, undefined, fingerprint);
    await tx.mutationReceipt.create({
      data: {
        householdId: lockedCtx.householdId,
        actorMemberId: lockedCtx.memberId,
        apiKeyId: "apiKeyId" in ctx && typeof ctx.apiKeyId === "string" ? ctx.apiKeyId : null,
        operation: "activity.create",
        targetActivityId: activity.id,
        clientMutationId: input.clientMutationId,
        intentFingerprint: fingerprint,
        outcomeActivityId: activity.id,
        outcomeSnapshot: outcomeSnapshot(activity)
      }
    });
    return activity;
  };

  try {
    return await prisma.$transaction((tx) => replayOrCreate(tx));
  } catch (error) {
    if (!isMutationReceiptUniqueError(error)) throw error;
    return prisma.$transaction((tx) => replayOrCreate(tx, true));
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
      ...(historicalFields ? {
        startedAt: historicalFields.startedAt,
        endedAt: historicalFields.endedAt,
        timezone: historicalFields.timezone,
        pauseTrackingStartedAt: historicalFields.pauseTrackingStartedAt,
        pauseTrackingBaselineSeconds: historicalFields.pauseTrackingBaselineSeconds,
        ...(historicalFields.pauseIntervals?.length ? {
          pauseIntervals: {
            create: historicalFields.pauseIntervals
          }
        } : {})
      } : {}),
      clientMutationId: input.clientMutationId,
      clientMutationFingerprint,
      household: { connect: { id: ctx.householdId } },
      baby: { connect: { id: input.babyId } },
      actorMember: { connect: { id: ctx.memberId } }
    },
    include: activityInclude
  });

  if (writeActivityAudit) {
    await writeAudit(ctx, { action: "activity.create", entityType: "activity", entityId: activity.id, babyId: activity.babyId, after: auditActivityPayload(activity) }, tx);
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
  requireValidHistoricalPauseIntervals(historicalTimer, historicalFields);
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
  const ctx = await getEffectiveHouseholdContext();
  return listActivitiesForContext(ctx, prisma, params);
}

export async function listActivitiesForContext(
  ctx: HouseholdContext,
  database: Pick<Prisma.TransactionClient, "activityLog">,
  params?: {
    babyId?: string;
    type?: string;
    search?: string;
    page?: ActivityListPage;
  }
) {
  requirePermission(ctx, "activity.read");
  return database.activityLog.findMany({
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

/**
 * A baby's newest feed in this household, for a new feed to start from: its kind, and the amount and
 * unit of the newest bottle or formula feed. Null without a baby or a feed.
 */
export async function getLastFeeding(babyId: string | undefined): Promise<LastFeeding | null> {
  if (!babyId) return null;
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");
  const where = { householdId: ctx.householdId, babyId, deletedAt: null, type: ActivityType.feeding };
  const orderBy = [{ occurredAt: "desc" as const }, { id: "desc" as const }];
  const [newest, newestLiquid] = await Promise.all([
    prisma.activityLog.findFirst({ where: { ...where, feeding: { isNot: null } }, orderBy, select: { feeding: { select: { mode: true } } } }),
    prisma.activityLog.findFirst({
      where: { ...where, feeding: { is: { mode: { in: [FeedingKind.bottle, FeedingKind.formula] }, amount: { not: null } } } },
      orderBy,
      select: { feeding: { select: { amount: true, unit: true } } }
    })
  ]);
  if (!newest?.feeding) return null;
  return { mode: newest.feeding.mode, amount: newestLiquid?.feeding?.amount?.toString() ?? null, unit: newestLiquid?.feeding?.unit ?? null };
}

/** Who is looking at a list of activities, for deciding which rows they may edit or delete. */
export async function getActivityRowViewer(): Promise<ActivityRowViewer> {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "activity.read");
  return { memberId: ctx.memberId, role: ctx.role };
}

export async function getActivityView(id: string) {
  const ctx = await getEffectiveHouseholdContext();
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

/**
 * The ActivityLog columns an edit writes, shared by the API and browser-operation update paths.
 *
 * Prisma treats `undefined` as "leave unchanged", and the form sends a cleared field as empty, which the
 * schema turns into `undefined`. So a note the user deleted, or a length they removed, used to survive
 * every edit. Cleared optional columns are written as `null`. A timer-backed activity keeps its own
 * timing, which only the timer controls may change; recomputing a stopped timer from its wall envelope
 * would add its paused time back into the active duration.
 */
export function activityLogUpdateData(
  babyId: string,
  next: Pick<ActivityCreateDraft, "type" | "occurredAt" | "startedAt" | "endedAt" | "durationSeconds" | "timezone" | "notes" | "timerState">,
  before: { timerState: TimerState; startedAt: Date | null; endedAt: Date | null; durationSeconds: number | null }
) {
  const timerBacked = before.timerState !== TimerState.none;
  return {
    babyId,
    type: next.type,
    occurredAt: next.occurredAt,
    startedAt: timerBacked ? before.startedAt : next.startedAt ?? null,
    endedAt: timerBacked ? before.endedAt : next.endedAt ?? null,
    durationSeconds: timerBacked ? before.durationSeconds : next.durationSeconds ?? null,
    timezone: next.timezone,
    notes: next.notes ?? null,
    timerState: before.timerState === TimerState.none ? next.timerState : before.timerState,
    pauseTrackingStartedAt:
      before.timerState === TimerState.none && next.timerState === TimerState.running ? next.startedAt : undefined,
    pauseTrackingBaselineSeconds:
      before.timerState === TimerState.none && next.timerState === TimerState.running ? 0 : undefined
  };
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

function receiptOutcomeSnapshot(receipt: { outcomeSnapshot: Prisma.JsonValue | null }) {
  return receipt.outcomeSnapshot == null ? null : JSON.parse(JSON.stringify(receipt.outcomeSnapshot));
}

function outcomeSnapshot(activity: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(activity));
}

export function activityUpdateFingerprint(id: string, input: ReturnType<typeof activityUpdateSchema.parse>) {
  const { clientMutationId: _clientMutationId, ...intent } = input;
  return createHash("sha256").update(JSON.stringify({ operation: "activity.update", activityId: id, intent })).digest("hex");
}

async function findActivityUpdateReplayInTransaction(
  tx: Prisma.TransactionClient,
  lockedCtx: HouseholdContext,
  id: string,
  input: ReturnType<typeof activityUpdateSchema.parse>
) {
  const receipt = await tx.mutationReceipt.findFirst({
    where: { householdId: lockedCtx.householdId, clientMutationId: input.clientMutationId }
  });
  if (!receipt) return null;
  if (
    receipt.actorMemberId !== lockedCtx.memberId ||
    receipt.operation !== "activity.update" ||
    receipt.targetActivityId !== id ||
    receipt.outcomeActivityId !== id ||
    receipt.intentFingerprint !== activityUpdateFingerprint(id, input)
  ) throw new Error("idempotency_conflict");
  const candidate = await tx.activityLog.findFirst({ where: { id, householdId: lockedCtx.householdId }, select: { babyId: true } });
  if (!candidate) throw new Error("not_found");
  await lockBabyForWrite(tx, lockedCtx, candidate.babyId);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ActivityLog" WHERE "id" = ${id} AND "householdId" = ${lockedCtx.householdId} FOR UPDATE
  `;
  if (locked.length !== 1) throw new Error("not_found");
  const target = await tx.activityLog.findFirst({ where: { id, householdId: lockedCtx.householdId }, include: activityInclude });
  if (!target) throw new Error("not_found");
  if (!canMutateOwnOrAny(lockedCtx.role, "update", target.actorMemberId === lockedCtx.memberId)) throw new Error("forbidden");
  return receiptOutcomeSnapshot(receipt) ?? target;
}

async function findActivityUpdateReplay(id: string, input: ReturnType<typeof activityUpdateSchema.parse>) {
  const ctx = await getEffectiveHouseholdContext();
  return prisma.$transaction(async (tx) => findActivityUpdateReplayInTransaction(tx, await lockActorForWrite(tx, ctx), id, input));
}

async function rejectLegacyActivityCreateReservation(tx: Prisma.TransactionClient, householdId: string, clientMutationId: string) {
  const reservation = await tx.activityLog.findFirst({
    where: { householdId, clientMutationId },
    select: { id: true, clientMutationId: true }
  });
  if (reservation?.clientMutationId === clientMutationId) throw new Error("idempotency_conflict");
}

export async function updateActivity(id: string, raw: unknown) {
  const ctx = await getEffectiveHouseholdContext();
  const medicineContactWasProvided = typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, "contactId");
  const input = activityUpdateSchema.parse({ ...(raw as object), id });
  const replay = await findActivityUpdateReplay(id, input);
  if (replay) return replay;
  try {
    return await prisma.$transaction(async (tx) => {
      const { ctx: lockedCtx, baby } = await lockActorAndBabyForWrite(tx, ctx, input.babyId);
      const lockedReplay = await findActivityUpdateReplayInTransaction(tx, lockedCtx, id, input);
      if (lockedReplay) return lockedReplay;
      const candidate = await tx.activityLog.findFirst({ where: { id, householdId: lockedCtx.householdId, deletedAt: null }, select: { babyId: true } });
      if (!candidate) throw new Error("stale_revision");
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "ActivityLog" WHERE "id" = ${id} AND "householdId" = ${lockedCtx.householdId} FOR UPDATE
      `;
      if (locked.length !== 1) throw new Error("stale_revision");
      const before = await tx.activityLog.findFirst({ where: { id, householdId: lockedCtx.householdId, deletedAt: null }, include: activityInclude });
      if (!before || before.babyId !== candidate.babyId || before.deletedAt) throw new Error("stale_revision");
      if (before.timerState !== TimerState.none && input.type !== before.type) throw new Error("not_found");
      if (!canMutateOwnOrAny(lockedCtx.role, "update", before.actorMemberId === lockedCtx.memberId)) throw new Error("forbidden");
      await rejectLegacyActivityCreateReservation(tx, lockedCtx.householdId, input.clientMutationId);
      const next = specificCreate(input);
      const expectedUpdatedAt = toDate(input.expectedUpdatedAt);
      if (!expectedUpdatedAt) throw new Error("validation_error");
      const activeTimer = before.timerState === TimerState.running || before.timerState === TimerState.paused;
      const startsTimer = before.timerState === TimerState.none && next.timerState === TimerState.running;
      if (baby.inactiveAt && (input.babyId !== before.babyId || startsTimer || activeTimer)) throw new Error("baby_inactive");
      if (input.type === "medicine" && medicineContactWasProvided && input.contactId) await requireHouseholdMedicineContact(tx, lockedCtx, input);
      const claimed = await tx.activityLog.updateMany({
        where: { id, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: expectedUpdatedAt },
        data: activityLogUpdateData(input.babyId, next, before)
      });
      if (claimed.count !== 1) throw new Error("stale_revision");
      await replaceSpecificLog(tx, id, input, medicineContactWasProvided ? undefined : before.medicine?.contactId);
      const updated = await tx.activityLog.findUniqueOrThrow({ where: { id }, include: activityInclude });
      await tx.mutationReceipt.create({ data: { householdId: lockedCtx.householdId, actorMemberId: lockedCtx.memberId, apiKeyId: null, operation: "activity.update", targetActivityId: id, clientMutationId: input.clientMutationId, intentFingerprint: activityUpdateFingerprint(id, input), outcomeActivityId: updated.id, outcomeSnapshot: outcomeSnapshot(updated) } });
      await writeAudit(lockedCtx, { action: "activity.update", entityType: "activity", entityId: updated.id, babyId: updated.babyId, before: auditActivityPayload(before), after: auditActivityPayload(updated) }, tx);
      await queueActivitySideEffects(lockedCtx, updated, WebhookEvent.activity_updated, tx);
      return updated;
    });
  } catch (error) {
    if (isMutationReceiptUniqueError(error) || (error instanceof Error && error.message === "stale_revision")) {
      const winner = await findActivityUpdateReplay(id, input);
      if (winner) return winner;
    }
    throw error;
  }
}

async function findActivityDeleteReplayInTransaction(
  tx: Prisma.TransactionClient,
  lockedCtx: HouseholdContext,
  id: string,
  mutation: ReturnType<typeof timerMutationInput>
) {
  const receipt = await tx.mutationReceipt.findFirst({
    where: { householdId: lockedCtx.householdId, clientMutationId: mutation.clientMutationId }
  });
  if (!receipt) return null;
  if (
    receipt.actorMemberId !== lockedCtx.memberId ||
    receipt.operation !== "activity.delete" ||
    receipt.targetActivityId !== id ||
    receipt.outcomeActivityId !== id ||
    receipt.intentFingerprint !== activityDeleteFingerprint(id)
  ) {
    throw new Error("idempotency_conflict");
  }
  const candidate = await tx.activityLog.findFirst({
    where: { id, householdId: lockedCtx.householdId },
    select: { babyId: true }
  });
  if (!candidate) throw new Error("not_found");
  await lockBabyForWrite(tx, lockedCtx, candidate.babyId);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "ActivityLog"
    WHERE "id" = ${id} AND "householdId" = ${lockedCtx.householdId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new Error("not_found");
  const target = await tx.activityLog.findFirst({
    where: { id, householdId: lockedCtx.householdId, babyId: candidate.babyId },
    include: activityInclude
  });
  if (!target) throw new Error("not_found");
  if (!canMutateOwnOrAny(lockedCtx.role, "delete", target.actorMemberId === lockedCtx.memberId)) {
    throw new Error("forbidden");
  }
  return receiptOutcomeSnapshot(receipt) ?? target;
}

async function findActivityDeleteReplay(id: string, mutation: ReturnType<typeof timerMutationInput>) {
  const ctx = await getEffectiveHouseholdContext();
  return prisma.$transaction(async (tx) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    return findActivityDeleteReplayInTransaction(tx, lockedCtx, id, mutation);
  });
}

export async function deleteActivity(id: string, raw?: unknown) {
  const mutation = timerMutationInput(raw);
  const replay = await findActivityDeleteReplay(id, mutation);
  if (replay) return replay;
  const ctx = await getEffectiveHouseholdContext();
  try {
    return await prisma.$transaction(async (tx) => {
      const lockedCtx = await lockActorForWrite(tx, ctx);
      const lockedReplay = await findActivityDeleteReplayInTransaction(tx, lockedCtx, id, mutation);
      if (lockedReplay) return lockedReplay;
      const candidate = await tx.activityLog.findFirst({
        where: { id, householdId: lockedCtx.householdId, deletedAt: null },
        select: { babyId: true }
      });
      if (!candidate) throw new Error("not_found");
      await lockBabyForWrite(tx, lockedCtx, candidate.babyId);
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "ActivityLog"
        WHERE "id" = ${id} AND "householdId" = ${lockedCtx.householdId}
        FOR UPDATE
      `;
      if (locked.length !== 1) throw new Error("not_found");
      const before = await tx.activityLog.findFirst({
        where: { id, householdId: lockedCtx.householdId, babyId: candidate.babyId, deletedAt: null },
        include: activityInclude
      });
      if (!before) throw new Error("not_found");
      if (!canMutateOwnOrAny(lockedCtx.role, "delete", before.actorMemberId === lockedCtx.memberId)) {
        throw new Error("forbidden");
      }
      const claimed = await tx.activityLog.updateMany({
        where: { id, householdId: lockedCtx.householdId, babyId: before.babyId, deletedAt: null, updatedAt: before.updatedAt },
        data: { deletedAt: new Date(), deletedByMemberId: lockedCtx.memberId }
      });
      if (claimed.count !== 1) throw new Error("stale_revision");
      const deleted = await tx.activityLog.findUniqueOrThrow({ where: { id }, include: activityInclude });
      await rejectLegacyActivityCreateReservation(tx, lockedCtx.householdId, mutation.clientMutationId);
      await tx.mutationReceipt.create({
        data: {
          householdId: lockedCtx.householdId,
          actorMemberId: lockedCtx.memberId,
          apiKeyId: null,
          operation: "activity.delete",
          targetActivityId: id,
          clientMutationId: mutation.clientMutationId,
          intentFingerprint: activityDeleteFingerprint(id),
          outcomeActivityId: deleted.id,
          outcomeSnapshot: outcomeSnapshot(deleted)
        }
      });
      await writeAudit(
        lockedCtx,
        { action: "activity.delete", entityType: "activity", entityId: id, babyId: deleted.babyId, before: auditActivityPayload(before), after: auditActivityPayload(deleted) },
        tx
      );
      await queueActivitySideEffects(lockedCtx, deleted, WebhookEvent.activity_deleted, tx);
      return deleted;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "stale_revision") {
      const winner = await findActivityDeleteReplay(id, mutation);
      if (winner) return winner;
    }
    if (isMutationReceiptUniqueError(error)) {
      const winner = await findActivityDeleteReplay(id, mutation);
      if (winner) return winner;
    }
    throw error;
  }
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
  const ctx = await getEffectiveHouseholdContext();
  const fingerprint = timerMutationFingerprint(operation, id);
  return prisma.$transaction(async (tx) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    const receipt = await tx.mutationReceipt.findFirst({ where: { householdId: lockedCtx.householdId, clientMutationId: mutation.clientMutationId } });
    if (!receipt) return null;
    if (receipt.actorMemberId !== lockedCtx.memberId || receipt.operation !== operation || receipt.targetActivityId !== id || receipt.intentFingerprint !== fingerprint) {
      throw new Error("idempotency_conflict");
    }
    const outcome = await tx.activityLog.findFirst({ where: { id: receipt.outcomeActivityId, householdId: lockedCtx.householdId }, include: activityInclude });
    if (!outcome) throw new Error("not_found");
    await lockBabyForWrite(tx, lockedCtx, outcome.babyId);
    if (!canMutateOwnOrAny(lockedCtx.role, "update", outcome.actorMemberId === lockedCtx.memberId)) throw new Error("forbidden");
    return receiptOutcomeSnapshot(receipt) ?? outcome;
  });
}

async function closeActivityTimerPauseInterval(
  tx: Prisma.TransactionClient,
  activityId: string,
  endedAt: Date
) {
  await tx.$queryRaw`
    SELECT "closeActivityTimerPauseInterval"(${activityId}::TEXT, ${endedAt}::TIMESTAMP)
  `;
}

export async function stopTimer(id: string, raw?: unknown, recoveringReceiptRace = false) {
  const mutation = timerMutationInput(raw);
  const replay = await findTimerReplay(id, mutation, "timer.stop");
  if (replay) return replay;
  const ctx = await getEffectiveHouseholdContext();
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
    if (!activity.pausedAt) {
      const openPauseCount = await tx.activityTimerPauseInterval.count({
        where: { activityId: activity.id, endedAt: null }
      });
      if (openPauseCount !== 0) throw new Error("pause_interval_state_invalid");
    }
    const claimed = await tx.activityLog.updateMany({
      where: { id: activity.id, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: activity.updatedAt },
      data: { endedAt, occurredAt: activity.startedAt!, durationSeconds: totalSeconds, timerState: TimerState.stopped, pausedAt: null, pausedSeconds }
    });
    if (claimed.count !== 1) throw new Error("stale_revision");
    if (activity.pausedAt) await closeActivityTimerPauseInterval(tx, activity.id, endedAt);
    const updated = await tx.activityLog.findUniqueOrThrow({ where: { id: activity.id }, include: activityInclude });
    await rejectLegacyActivityCreateReservation(tx, lockedCtx.householdId, mutation.clientMutationId);
    await tx.mutationReceipt.create({
      data: {
        householdId: lockedCtx.householdId,
        actorMemberId: lockedCtx.memberId,
        apiKeyId: null,
        operation: "timer.stop",
        targetActivityId: activity.id,
        clientMutationId: mutation.clientMutationId,
        intentFingerprint: timerMutationFingerprint("timer.stop", activity.id),
        outcomeActivityId: updated.id,
        outcomeSnapshot: outcomeSnapshot(updated)
      }
    });
    await writeAudit(lockedCtx, { action: "activity.timer.stop", entityType: "activity", entityId: activity.id, babyId: activity.babyId, before: auditActivityPayload(activity), after: auditActivityPayload(updated) }, tx);
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
  const ctx = await getEffectiveHouseholdContext();
  const activity = await getEditableActivity(ctx, id, "update");
  if (activity.timerState !== TimerState.running || !activity.startedAt) throw new Error("not_found");
  try {
    return await prisma.$transaction(async (tx) => {
      const { ctx: lockedCtx } = await lockActorAndBabyForWrite(tx, ctx, activity.babyId);
      if (!canMutateOwnOrAny(lockedCtx.role, "update", activity.actorMemberId === lockedCtx.memberId)) throw new Error("forbidden");
      const pausedAt = new Date();
      const claimed = await tx.activityLog.updateMany({
        where: { id: activity.id, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: activity.updatedAt, timerState: TimerState.running },
        data: { timerState: TimerState.paused, pausedAt }
      });
      if (claimed.count !== 1) throw new Error("stale_revision");
      await tx.activityTimerPauseInterval.create({ data: { activityId: activity.id, startedAt: pausedAt } });
      const updated = await tx.activityLog.findUniqueOrThrow({ where: { id: activity.id }, include: activityInclude });
      await rejectLegacyActivityCreateReservation(tx, lockedCtx.householdId, mutation.clientMutationId);
      await tx.mutationReceipt.create({
        data: {
          householdId: lockedCtx.householdId,
          actorMemberId: lockedCtx.memberId,
          apiKeyId: null,
          operation: "timer.pause",
          targetActivityId: activity.id,
          clientMutationId: mutation.clientMutationId,
          intentFingerprint: timerMutationFingerprint("timer.pause", activity.id),
          outcomeActivityId: updated.id,
          outcomeSnapshot: outcomeSnapshot(updated)
        }
      });
      await writeAudit(lockedCtx, { action: "activity.timer.pause", entityType: "activity", entityId: activity.id, babyId: activity.babyId, before: auditActivityPayload(activity), after: auditActivityPayload(updated) }, tx);
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
  const ctx = await getEffectiveHouseholdContext();
  const activity = await getEditableActivity(ctx, id, "update");
  if (activity.timerState !== TimerState.paused || !activity.pausedAt) throw new Error("not_found");
  try {
    return await prisma.$transaction(async (tx) => {
      const { ctx: lockedCtx, baby } = await lockActorAndBabyForWrite(tx, ctx, activity.babyId);
      if (!canMutateOwnOrAny(lockedCtx.role, "update", activity.actorMemberId === lockedCtx.memberId)) throw new Error("forbidden");
      if (baby.inactiveAt) throw new Error("baby_inactive");
      const resumedAt = new Date();
      const claimed = await tx.activityLog.updateMany({
        where: { id: activity.id, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: activity.updatedAt, timerState: TimerState.paused },
        data: { timerState: TimerState.running, pausedSeconds: activity.pausedSeconds + durationSeconds(activity.pausedAt!, resumedAt), pausedAt: null }
      });
      if (claimed.count !== 1) throw new Error("stale_revision");
      await closeActivityTimerPauseInterval(tx, activity.id, resumedAt);
      const updated = await tx.activityLog.findUniqueOrThrow({ where: { id: activity.id }, include: activityInclude });
      await rejectLegacyActivityCreateReservation(tx, lockedCtx.householdId, mutation.clientMutationId);
      await tx.mutationReceipt.create({
        data: { householdId: lockedCtx.householdId, actorMemberId: lockedCtx.memberId, apiKeyId: null, operation: "timer.resume", targetActivityId: activity.id, clientMutationId: mutation.clientMutationId, intentFingerprint: timerMutationFingerprint("timer.resume", activity.id), outcomeActivityId: updated.id, outcomeSnapshot: outcomeSnapshot(updated) }
      });
      await writeAudit(lockedCtx, { action: "activity.timer.resume", entityType: "activity", entityId: activity.id, babyId: activity.babyId, before: auditActivityPayload(activity), after: auditActivityPayload(updated) }, tx);
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

async function findActivityUndoReplayInTransaction(
  tx: Prisma.TransactionClient,
  lockedCtx: HouseholdContext,
  mutation: ReturnType<typeof timerMutationInput>
) {
  const receipt = await tx.mutationReceipt.findFirst({
    where: { householdId: lockedCtx.householdId, clientMutationId: mutation.clientMutationId }
  });
  if (!receipt) return null;
  const deleteFingerprint = activityUndoFingerprint(receipt.targetActivityId, "delete");
  const updateFingerprint = activityUndoFingerprint(receipt.targetActivityId, "update");
  const permissionAction =
    receipt.intentFingerprint === deleteFingerprint
      ? "delete"
      : receipt.intentFingerprint === updateFingerprint
        ? "update"
        : null;
  if (
    receipt.actorMemberId !== lockedCtx.memberId ||
    receipt.operation !== "activity.undo" ||
    receipt.outcomeActivityId !== receipt.targetActivityId ||
    permissionAction === null
  ) {
    throw new Error("idempotency_conflict");
  }
  const candidate = await tx.activityLog.findFirst({
    where: { id: receipt.outcomeActivityId, householdId: lockedCtx.householdId },
    select: { babyId: true }
  });
  if (!candidate) throw new Error("not_found");
  await lockBabyForWrite(tx, lockedCtx, candidate.babyId);
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "ActivityLog"
    WHERE "id" = ${receipt.outcomeActivityId} AND "householdId" = ${lockedCtx.householdId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new Error("not_found");
  const target = await tx.activityLog.findFirst({
    where: { id: receipt.outcomeActivityId, householdId: lockedCtx.householdId, babyId: candidate.babyId },
    include: activityInclude
  });
  if (!target) throw new Error("not_found");
  if (!canMutateOwnOrAny(lockedCtx.role, permissionAction, target.actorMemberId === lockedCtx.memberId)) {
    throw new Error("forbidden");
  }
  return receiptOutcomeSnapshot(receipt) ?? { id: target.id };
}

async function findActivityUndoReplay(mutation: ReturnType<typeof timerMutationInput>) {
  const ctx = await getEffectiveHouseholdContext();
  return prisma.$transaction(async (tx) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    return findActivityUndoReplayInTransaction(tx, lockedCtx, mutation);
  });
}

export async function undoLastActivity(raw?: unknown) {
  const mutation = timerMutationInput(raw);
  const replay = await findActivityUndoReplay(mutation);
  if (replay) return replay;
  const ctx = await getEffectiveHouseholdContext();
  try {
    return await prisma.$transaction(async (tx) => {
      const lockedCtx = await lockActorForWrite(tx, ctx);
      const lockedReplay = await findActivityUndoReplayInTransaction(tx, lockedCtx, mutation);
      if (lockedReplay) return lockedReplay;
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
      if (claimed.count !== 1) throw new Error("stale_revision");
      const after = await tx.activityLog.findUniqueOrThrow({ where: { id: before.id }, include: activityInclude });
      await rejectLegacyActivityCreateReservation(tx, lockedCtx.householdId, mutation.clientMutationId);
      await tx.mutationReceipt.create({
        data: {
          householdId: lockedCtx.householdId,
          actorMemberId: lockedCtx.memberId,
          apiKeyId: null,
          operation: "activity.undo",
          targetActivityId: before.id,
          clientMutationId: mutation.clientMutationId,
          intentFingerprint: activityUndoFingerprint(before.id, undoCreate ? "delete" : "update"),
          outcomeActivityId: after.id,
          outcomeSnapshot: outcomeSnapshot({ id: before.id })
        }
      });
      await writeAudit(
        lockedCtx,
        { action: "activity.undo", entityType: "activity", entityId: before.id, babyId: before.babyId, before: auditActivityPayload(before), after: auditActivityPayload(after) },
        tx
      );
      return { id: before.id };
    });
  } catch (error) {
    if (isMutationReceiptUniqueError(error) || (error instanceof Error && error.message === "stale_revision")) {
      const recovered = await findActivityUndoReplay(mutation);
      if (recovered) return recovered;
    }
    throw error;
  }
}

function activityBrowserOpeningInput(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("validation_error");
  return raw as Record<string, unknown>;
}

function requiredActivityBrowserId(raw: Record<string, unknown>, field: "activityId" | "babyId") {
  const value = raw[field];
  if (typeof value !== "string" || !value) throw new Error("validation_error");
  return value;
}

async function lockActivityBrowserTargets(
  tx: Prisma.TransactionClient,
  ctx: HouseholdContext,
  activityId: string,
  replacementBabyId?: string
) {
  const candidate = await tx.activityLog.findFirst({
    where: { id: activityId, householdId: ctx.householdId },
    select: { babyId: true }
  });
  if (!candidate) throw new Error("not_found");

  const babyIds = [...new Set([candidate.babyId, replacementBabyId].filter((id): id is string => Boolean(id)))].sort();
  const babies = [] as Array<{ id: string; updatedAt: Date; inactiveAt: Date | null }>;
  for (const babyId of babyIds) {
    const babyLock = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Baby" WHERE "id" = ${babyId} AND "householdId" = ${ctx.householdId} AND "deletedAt" IS NULL FOR UPDATE
    `;
    if (babyLock.length !== 1) throw new Error("not_found");
    const baby = await tx.baby.findFirst({
      where: { id: babyId, householdId: ctx.householdId, deletedAt: null },
      select: { id: true, updatedAt: true, inactiveAt: true }
    });
    if (!baby) throw new Error("not_found");
    babies.push(baby);
  }
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "ActivityLog" WHERE "id" = ${activityId} AND "householdId" = ${ctx.householdId} FOR UPDATE
  `;
  if (locked.length !== 1) throw new Error("not_found");
  const activity = await tx.activityLog.findFirst({
    where: { id: activityId, householdId: ctx.householdId },
    include: activityInclude
  });
  if (!activity || activity.babyId !== candidate.babyId) throw new Error("stale_revision");
  return { activity, babies };
}

async function activityBindingSnapshot(tx: Prisma.TransactionClient, ctx: HouseholdContext, activityId: string, replacementBabyId?: string) {
  const { activity, babies } = await lockActivityBrowserTargets(tx, ctx, activityId, replacementBabyId);
  return {
    activity: {
      id: activity.id,
      babyId: activity.babyId,
      updatedAt: activity.updatedAt.toISOString(),
      deletedAt: activity.deletedAt?.toISOString() ?? null,
      timerState: activity.timerState,
      actorMemberId: activity.actorMemberId
    },
    babies: babies.map((baby) => ({
      id: baby.id,
      updatedAt: baby.updatedAt.toISOString(),
      inactiveAt: baby.inactiveAt?.toISOString() ?? null
    }))
  };
}

export async function issueActivityCreateBrowserOperation(raw: unknown): Promise<BrowserOperationResult> {
  const input = activityBrowserOpeningInput(raw);
  const babyId = requiredActivityBrowserId(input, "babyId");
  const ctx = await getBrowserOperationContextForBaby(babyId);
  return issueBrowserOperation({ ctx, operationId: input.operationId, operationKey: BrowserOperationKey.activityCreate, opening: { babyId }, babyId, targetKind: "baby", targetId: babyId, permission: "activity.create", targetSnapshot: async (_tx, _ctx, baby) => ({ id: baby.id, updatedAt: baby.updatedAt.toISOString(), inactiveAt: baby.inactiveAt?.toISOString() ?? null }) });
}

export async function issueActivityUpdateBrowserOperation(raw: unknown): Promise<BrowserOperationResult> {
  const input = activityBrowserOpeningInput(raw);
  const activityId = requiredActivityBrowserId(input, "activityId");
  const replacementBabyId = requiredActivityBrowserId(input, "babyId");
  const ctx = await getBrowserOperationContextForHousehold();
  return issueHouseholdBrowserOperation({ ctx, operationId: input.operationId, operationKey: BrowserOperationKey.activityUpdate, targetKind: "activity", targetId: activityId, permission: "activity.read", targetSnapshot: (tx, lockedCtx) => activityBindingSnapshot(tx, lockedCtx, activityId, replacementBabyId) });
}

export async function issueActivityDeleteBrowserOperation(raw: unknown): Promise<BrowserOperationResult> {
  const input = activityBrowserOpeningInput(raw);
  const activityId = requiredActivityBrowserId(input, "activityId");
  const ctx = await getBrowserOperationContextForHousehold();
  return issueHouseholdBrowserOperation({ ctx, operationId: input.operationId, operationKey: BrowserOperationKey.activityDelete, targetKind: "activity", targetId: activityId, permission: "activity.read", targetSnapshot: (tx, lockedCtx) => activityBindingSnapshot(tx, lockedCtx, activityId) });
}

export async function issueActivityTimerBrowserOperation(operation: "pause" | "resume" | "stop", raw: unknown): Promise<BrowserOperationResult> {
  const input = activityBrowserOpeningInput(raw);
  const activityId = requiredActivityBrowserId(input, "activityId");
  const ctx = await getBrowserOperationContextForHousehold();
  const operationKey = operation === "pause" ? BrowserOperationKey.activityTimerPause : operation === "resume" ? BrowserOperationKey.activityTimerResume : BrowserOperationKey.activityTimerStop;
  return issueHouseholdBrowserOperation({ ctx, operationId: input.operationId, operationKey, targetKind: "activity", targetId: activityId, permission: "activity.read", targetSnapshot: (tx, lockedCtx) => activityBindingSnapshot(tx, lockedCtx, activityId) });
}

export async function issueActivityUndoLastBrowserOperation(raw: unknown): Promise<BrowserOperationResult> {
  const input = activityBrowserOpeningInput(raw);
  const ctx = await getBrowserOperationContextForHousehold();
  const candidate = await prisma.auditEvent.findFirst({
    where: { householdId: ctx.householdId, actorMemberId: ctx.memberId, entityType: "activity", action: { in: ["activity.create", "activity.delete"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, entityId: true }
  });
  if (!candidate) throw new Error("not_found");
  return issueHouseholdBrowserOperation({
    ctx, operationId: input.operationId, operationKey: BrowserOperationKey.activityUndoLast, targetKind: "activity", targetId: candidate.entityId, permission: "activity.read",
    targetSnapshot: async (tx, lockedCtx) => {
      const latest = await tx.auditEvent.findFirst({ where: { householdId: lockedCtx.householdId, actorMemberId: lockedCtx.memberId, entityType: "activity", action: { in: ["activity.create", "activity.delete"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, action: true, entityId: true, createdAt: true, after: true } });
      if (!latest || latest.id !== candidate.id || latest.entityId !== candidate.entityId) throw new Error("stale_revision");
      return { latest: { id: latest.id, action: latest.action, entityId: latest.entityId, createdAt: latest.createdAt.toISOString(), state: auditActivityState(latest.after) }, binding: await activityBindingSnapshot(tx, lockedCtx, latest.entityId) };
    }
  });
}

function bindingActivityId(snapshot: unknown) {
  const record = snapshot as { activity?: { id?: unknown; updatedAt?: unknown; deletedAt?: unknown; timerState?: unknown; babyId?: unknown } };
  const activity = record?.activity;
  if (!activity || typeof activity.id !== "string" || typeof activity.updatedAt !== "string" || typeof activity.babyId !== "string") throw new Error("not_found");
  return activity as { id: string; updatedAt: string; deletedAt: string | null; timerState: TimerState; babyId: string };
}

async function assertCurrentActivityBinding(
  tx: Prisma.TransactionClient,
  ctx: HouseholdContext,
  snapshot: unknown,
  id: string,
  replacementBabyId?: string
) {
  const expected = bindingActivityId(snapshot);
  if (expected.id !== id) throw new Error("not_found");
  const { activity: current } = await lockActivityBrowserTargets(tx, ctx, id, replacementBabyId);
  if (
    current.updatedAt.toISOString() !== expected.updatedAt ||
    (current.deletedAt?.toISOString() ?? null) !== expected.deletedAt ||
    current.timerState !== expected.timerState ||
    current.babyId !== expected.babyId
  ) throw new Error("stale_revision");
  return current;
}

export async function submitActivityCreateBrowserOperation(raw: unknown): Promise<BrowserOperationResult> {
  const input = activityBrowserCreateSchema.parse(raw);
  const ctx = await getBrowserOperationContextForBaby(input.babyId);
  return executeBrowserOperation({
    ctx, operationId: (raw as Record<string, unknown>).operationId, operationKey: BrowserOperationKey.activityCreate, intent: input, babyId: input.babyId, permission: "activity.create",
    validate: async (_tx, _ctx, baby, binding) => {
      const snapshot = binding.targetSnapshot as { id?: unknown; updatedAt?: unknown };
      if (snapshot.id !== baby.id || snapshot.updatedAt !== baby.updatedAt.toISOString()) throw new Error("stale_revision");
    },
    execute: async (tx, lockedCtx) => {
      const activity = await createActivityInTransaction({ ...input, clientMutationId: undefined }, lockedCtx, tx, true);
      return { kind: "activity", code: "ok", activityId: activity.id, action: "create" as const };
    }
  });
}

export async function submitActivityUpdateBrowserOperation(raw: unknown): Promise<BrowserOperationResult> {
  const record = activityBrowserOpeningInput(raw);
  const id = requiredActivityBrowserId(record, "activityId");
  const medicineContactWasProvided = Object.prototype.hasOwnProperty.call(record, "contactId");
  const input = activityBrowserUpdateSchema.parse({ ...record, id });
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx, operationId: record.operationId, operationKey: BrowserOperationKey.activityUpdate, intent: input, targetKind: "activity", targetId: id, permission: "activity.read",
    validate: async (tx, lockedCtx, binding) => {
      const before = await assertCurrentActivityBinding(tx, lockedCtx, binding.targetSnapshot, id, input.babyId);
      if (toDate(input.expectedUpdatedAt)?.toISOString() !== before.updatedAt.toISOString()) throw new Error("stale_revision");
      const snapshot = binding.targetSnapshot as { babies?: Array<{ id?: string; updatedAt?: string; inactiveAt?: string | null }> };
      const ids = [before.babyId, input.babyId].sort();
      for (const babyId of ids) {
        const expected = snapshot.babies?.find((item) => item.id === babyId);
        const baby = await tx.baby.findFirst({ where: { id: babyId, householdId: lockedCtx.householdId, deletedAt: null } });
        if (!expected || !baby || baby.updatedAt.toISOString() !== expected.updatedAt || (baby.inactiveAt?.toISOString() ?? null) !== (expected.inactiveAt ?? null)) throw new Error("stale_revision");
      }
    },
    execute: async (tx, lockedCtx, binding) => {
      const before = await assertCurrentActivityBinding(tx, lockedCtx, binding.targetSnapshot, id, input.babyId);
      if (!canMutateOwnOrAny(lockedCtx.role, "update", before.actorMemberId === lockedCtx.memberId)) throw new Error("forbidden");
      const next = specificCreate(input);
      const activeTimer = before.timerState === TimerState.running || before.timerState === TimerState.paused;
      if (before.timerState !== TimerState.none && input.type !== before.type) throw new Error("state_conflict");
      const startsTimer = before.timerState === TimerState.none && next.timerState === TimerState.running;
      const replacementBaby = await tx.baby.findFirst({
        where: { id: input.babyId, householdId: lockedCtx.householdId, deletedAt: null },
        select: { inactiveAt: true }
      });
      if (!replacementBaby) throw new Error("not_found");
      if (replacementBaby.inactiveAt && (input.babyId !== before.babyId || startsTimer || activeTimer)) throw new Error("baby_inactive");
      if (input.type === "medicine" && medicineContactWasProvided && input.contactId) {
        await requireHouseholdMedicineContact(tx, lockedCtx, input);
      }
      const claimed = await tx.activityLog.updateMany({ where: { id, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: before.updatedAt }, data: activityLogUpdateData(input.babyId, next, before) });
      if (claimed.count !== 1) throw new Error("stale_revision");
      await replaceSpecificLog(tx, id, input, medicineContactWasProvided ? undefined : before.medicine?.contactId);
      const updated = await tx.activityLog.findUniqueOrThrow({ where: { id }, include: activityInclude });
      await writeAudit(lockedCtx, { action: "activity.update", entityType: "activity", entityId: id, babyId: updated.babyId, before: auditActivityPayload(before), after: auditActivityPayload(updated) }, tx);
      await queueActivitySideEffects(lockedCtx, updated, WebhookEvent.activity_updated, tx);
      return { kind: "activity", code: "ok", activityId: id, action: "update" as const };
    }
  });
}

export async function submitActivityDeleteBrowserOperation(raw: unknown): Promise<BrowserOperationResult> {
  const record = activityBrowserOpeningInput(raw);
  const id = requiredActivityBrowserId(record, "activityId");
  const ctx = await getBrowserOperationContextForHousehold();
  return executeHouseholdBrowserOperation({
    ctx, operationId: record.operationId, operationKey: BrowserOperationKey.activityDelete, intent: { activityId: id }, targetKind: "activity", targetId: id, permission: "activity.read",
    validate: (tx, lockedCtx, binding) => assertCurrentActivityBinding(tx, lockedCtx, binding.targetSnapshot, id).then(() => undefined),
    execute: async (tx, lockedCtx, binding) => {
      const before = await assertCurrentActivityBinding(tx, lockedCtx, binding.targetSnapshot, id);
      if (!canMutateOwnOrAny(lockedCtx.role, "delete", before.actorMemberId === lockedCtx.memberId)) throw new Error("forbidden");
      const claimed = await tx.activityLog.updateMany({ where: { id, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: before.updatedAt }, data: { deletedAt: new Date(), deletedByMemberId: lockedCtx.memberId } });
      if (claimed.count !== 1) throw new Error("stale_revision");
      const deleted = await tx.activityLog.findUniqueOrThrow({ where: { id }, include: activityInclude });
      await writeAudit(lockedCtx, { action: "activity.delete", entityType: "activity", entityId: id, babyId: deleted.babyId, before: auditActivityPayload(before), after: auditActivityPayload(deleted) }, tx);
      await queueActivitySideEffects(lockedCtx, deleted, WebhookEvent.activity_deleted, tx);
      return { kind: "activity", code: "ok", activityId: id, action: "delete" as const };
    }
  });
}

export async function submitActivityTimerBrowserOperation(operation: "pause" | "resume" | "stop", raw: unknown): Promise<BrowserOperationResult> {
  const record = activityBrowserOpeningInput(raw);
  const id = requiredActivityBrowserId(record, "activityId");
  const ctx = await getBrowserOperationContextForHousehold();
  const operationKey = operation === "pause" ? BrowserOperationKey.activityTimerPause : operation === "resume" ? BrowserOperationKey.activityTimerResume : BrowserOperationKey.activityTimerStop;
  return executeHouseholdBrowserOperation({
    ctx, operationId: record.operationId, operationKey, intent: { activityId: id, operation }, targetKind: "activity", targetId: id, permission: "activity.read",
    validate: (tx, lockedCtx, binding) => assertCurrentActivityBinding(tx, lockedCtx, binding.targetSnapshot, id).then(() => undefined),
    execute: async (tx, lockedCtx, binding) => {
      const before = await assertCurrentActivityBinding(tx, lockedCtx, binding.targetSnapshot, id);
      if (!canMutateOwnOrAny(lockedCtx.role, "update", before.actorMemberId === lockedCtx.memberId)) throw new Error("forbidden");
      if (!before.startedAt || (operation === "pause" && before.timerState !== TimerState.running) || (operation === "resume" && (before.timerState !== TimerState.paused || !before.pausedAt)) || (operation === "stop" && before.timerState !== TimerState.running && before.timerState !== TimerState.paused)) throw new Error("state_conflict");
      const now = new Date();
      if (operation === "stop" && !before.pausedAt) {
        const openPauseCount = await tx.activityTimerPauseInterval.count({
          where: { activityId: id, endedAt: null }
        });
        if (openPauseCount !== 0) throw new Error("pause_interval_state_invalid");
      }
      const data = operation === "pause"
        ? { timerState: TimerState.paused, pausedAt: now }
        : operation === "resume"
          ? { timerState: TimerState.running, pausedAt: null, pausedSeconds: before.pausedSeconds + durationSeconds(before.pausedAt!, now) }
          : { timerState: TimerState.stopped, endedAt: now, occurredAt: before.startedAt, pausedAt: null, pausedSeconds: before.pausedSeconds + (before.pausedAt ? durationSeconds(before.pausedAt, now) : 0), durationSeconds: Math.max(0, durationSeconds(before.startedAt, now) - before.pausedSeconds - (before.pausedAt ? durationSeconds(before.pausedAt, now) : 0)) };
      const claimed = await tx.activityLog.updateMany({ where: { id, householdId: lockedCtx.householdId, deletedAt: null, updatedAt: before.updatedAt, ...(operation === "pause" ? { timerState: TimerState.running } : operation === "resume" ? { timerState: TimerState.paused } : { timerState: { in: [TimerState.running, TimerState.paused] } }) }, data });
      if (claimed.count !== 1) throw new Error("stale_revision");
      if (operation === "pause") {
        await tx.activityTimerPauseInterval.create({ data: { activityId: id, startedAt: now } });
      } else if (before.pausedAt) {
        await closeActivityTimerPauseInterval(tx, id, now);
      }
      const updated = await tx.activityLog.findUniqueOrThrow({ where: { id }, include: activityInclude });
      await writeAudit(lockedCtx, { action: `activity.timer.${operation}`, entityType: "activity", entityId: id, babyId: updated.babyId, before: auditActivityPayload(before), after: auditActivityPayload(updated) }, tx);
      if (operation === "stop") await queueActivitySideEffects(lockedCtx, updated, WebhookEvent.timer_stopped, tx);
      return { kind: "activity", code: "ok", activityId: id, action: `timer.${operation}` as "timer.pause" | "timer.resume" | "timer.stop" };
    }
  });
}

async function undoLastBindingTarget(
  ctx: { householdId: string; memberId: string },
  operationId: unknown
): Promise<string> {
  if (typeof operationId !== "string" || !operationId) throw new Error("validation_error");
  const binding = await prisma.browserOperationBinding.findFirst({
    where: {
      householdId: ctx.householdId,
      operationId,
      actorMemberId: ctx.memberId,
      operationKey: BrowserOperationKey.activityUndoLast
    },
    select: { targetId: true }
  });
  if (!binding?.targetId) throw new Error("not_found");
  return binding.targetId;
}

export async function submitActivityUndoLastBrowserOperation(raw: unknown): Promise<BrowserOperationResult> {
  const record = activityBrowserOpeningInput(raw);
  const ctx = await getBrowserOperationContextForHousehold();
  // Undo-last is the one activity operation whose target the caller cannot name: the issue step
  // picks the member's most recent create/delete itself, and the client only ever learns an
  // operation id back. Requiring activityId in the submit body therefore rejected every real
  // request with validation_error - the Undo last button sends exactly `{operationId}`. The target
  // is taken from the binding the issue step recorded instead; every check below still runs against
  // that binding's snapshot inside the transaction, so the operation stays pinned to what was
  // opened rather than to whatever is newest at submit time.
  const activityId = typeof record.activityId === "string" && record.activityId
    ? record.activityId
    : await undoLastBindingTarget(ctx, record.operationId);
  return executeHouseholdBrowserOperation({
    ctx, operationId: record.operationId, operationKey: BrowserOperationKey.activityUndoLast, intent: { activityId }, targetKind: "activity", targetId: activityId, permission: "activity.read",
    validate: async (tx, lockedCtx, binding) => {
      const snapshot = binding.targetSnapshot as { latest?: { id?: string; entityId?: string; action?: string; state?: ReturnType<typeof auditActivityState> }; binding?: unknown };
      if (!snapshot.latest || snapshot.latest.entityId !== activityId) throw new Error("not_found");
      const latest = await tx.auditEvent.findFirst({ where: { householdId: lockedCtx.householdId, actorMemberId: lockedCtx.memberId, entityType: "activity", action: { in: ["activity.create", "activity.delete"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, action: true, entityId: true } });
      if (!latest || latest.id !== snapshot.latest.id || latest.entityId !== activityId || latest.action !== snapshot.latest.action) throw new Error("stale_revision");
      await assertCurrentActivityBinding(tx, lockedCtx, snapshot.binding, activityId);
    },
    execute: async (tx, lockedCtx, binding) => {
      const snapshot = binding.targetSnapshot as { latest: { action: string; state: ReturnType<typeof auditActivityState> }; binding: unknown };
      const before = await assertCurrentActivityBinding(tx, lockedCtx, snapshot.binding, activityId);
      const undoCreate = snapshot.latest.action === "activity.create";
      const expected = snapshot.latest.state;
      if (!expected || (undoCreate ? expected.deletedAt !== null : expected.deletedAt === null)) throw new Error("not_found");
      if (!canMutateOwnOrAny(lockedCtx.role, undoCreate ? "delete" : "update", before.actorMemberId === lockedCtx.memberId)) throw new Error("forbidden");
      const baby = await tx.baby.findFirst({ where: { id: before.babyId, householdId: lockedCtx.householdId, deletedAt: null }, select: { inactiveAt: true } });
      if (!baby) throw new Error("not_found");
      if (!undoCreate && (before.timerState === TimerState.running || before.timerState === TimerState.paused) && baby.inactiveAt) throw new Error("baby_inactive");
      const claimed = await tx.activityLog.updateMany({ where: { id: before.id, householdId: lockedCtx.householdId, deletedAt: before.deletedAt, updatedAt: before.updatedAt }, data: undoCreate ? { deletedAt: new Date(), deletedByMemberId: lockedCtx.memberId } : { deletedAt: null, deletedByMemberId: null } });
      if (claimed.count !== 1) throw new Error("stale_revision");
      const after = await tx.activityLog.findUniqueOrThrow({ where: { id: before.id }, include: activityInclude });
      await writeAudit(lockedCtx, { action: "activity.undo", entityType: "activity", entityId: before.id, babyId: before.babyId, before: auditActivityPayload(before), after: auditActivityPayload(after) }, tx);
      return { kind: "activity", code: "ok", activityId: before.id, action: "undo" as const };
    }
  });
}
