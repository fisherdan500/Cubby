import { createHash, randomBytes } from "node:crypto";
import {
  BrowserMutationOperationStatus,
  BrowserOperationKey,
  BrowserOperationProtocolVersion,
  BrowserOperationTargetKind,
  Prisma
} from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/server/auth/session";
import { getEffectiveHouseholdContext, requirePermission, type HouseholdContext } from "@/server/auth/context";
import { recordQualifyingGlobalSessionUseAfterSuccess } from "@/server/services/global-session-security";

export const browserOperationLeaseMs = 30 * 60 * 1000;

const operationIdPattern = /^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const operationIdSchema = z.string().regex(operationIdPattern);
const browserOperationKeySchema = z.nativeEnum(BrowserOperationKey);
const terminalOutcomeSchemas: Partial<Record<BrowserOperationKey, z.ZodType<Record<string, unknown>>>> = {
  [BrowserOperationKey.babyCreate]: z.object({
    kind: z.literal("baby_create"),
    code: z.literal("ok"),
    babyId: z.string().min(1)
  }).strict(),
  [BrowserOperationKey.inviteCreate]: z.object({
    kind: z.literal("invite"),
    code: z.literal("created"),
    inviteId: z.string().min(1),
    email: z.string().email(),
    role: z.enum(["admin", "parent", "caretaker", "read_only"]),
    expiresAt: z.string().datetime()
  }).strict(),
  [BrowserOperationKey.inviteRevoke]: z.object({
    kind: z.literal("invite"),
    code: z.literal("revoked"),
    inviteId: z.string().min(1)
  }).strict(),
  [BrowserOperationKey.inviteRevokeAll]: z.object({
    kind: z.literal("invite_bulk"),
    code: z.literal("revoked"),
    revokedCount: z.number().int().nonnegative()
  }).strict(),
  [BrowserOperationKey.calendarEventCreate]: z.object({
    kind: z.literal("calendar_event"),
    code: z.literal("ok"),
    eventId: z.string().min(1)
  }).strict(),
  [BrowserOperationKey.activityCreate]: z.object({ kind: z.literal("activity"), code: z.literal("ok"), activityId: z.string().min(1), action: z.literal("create") }).strict(),
  [BrowserOperationKey.activityUpdate]: z.object({ kind: z.literal("activity"), code: z.literal("ok"), activityId: z.string().min(1), action: z.literal("update") }).strict(),
  [BrowserOperationKey.activityDelete]: z.object({ kind: z.literal("activity"), code: z.literal("ok"), activityId: z.string().min(1), action: z.literal("delete") }).strict(),
  [BrowserOperationKey.activityUndoLast]: z.object({ kind: z.literal("activity"), code: z.literal("ok"), activityId: z.string().min(1), action: z.literal("undo") }).strict(),
  [BrowserOperationKey.activityTimerPause]: z.object({ kind: z.literal("activity"), code: z.literal("ok"), activityId: z.string().min(1), action: z.literal("timer.pause") }).strict(),
  [BrowserOperationKey.activityTimerResume]: z.object({ kind: z.literal("activity"), code: z.literal("ok"), activityId: z.string().min(1), action: z.literal("timer.resume") }).strict(),
  [BrowserOperationKey.activityTimerStop]: z.object({ kind: z.literal("activity"), code: z.literal("ok"), activityId: z.string().min(1), action: z.literal("timer.stop") }).strict(),
  [BrowserOperationKey.dashboardWarningDismiss]: z.object({
    kind: z.literal("warning_dismissed"),
    code: z.literal("ok"),
    warningKey: z.string().min(1)
  }).strict(),
  [BrowserOperationKey.babyDeactivate]: z.object({
    kind: z.literal("baby_lifecycle"),
    code: z.literal("ok"),
    babyId: z.string().min(1),
    inactive: z.literal(true)
  }).strict(),
  [BrowserOperationKey.babyReactivate]: z.object({
    kind: z.literal("baby_lifecycle"),
    code: z.literal("ok"),
    babyId: z.string().min(1),
    inactive: z.literal(false)
  }).strict(),
  [BrowserOperationKey.householdAccentUpdate]: z.object({
    kind: z.literal("household_accent"),
    code: z.literal("ok"),
    settingsScope: z.literal("household"),
    accentTheme: z.enum(["sage", "rose", "powder", "butter", "terracotta"])
  }).strict(),
  [BrowserOperationKey.settingsUnitsUpdate]: z.object({
    kind: z.literal("units_updated"),
    code: z.literal("ok"),
    settingsScope: z.literal("household")
  }).strict(),
  [BrowserOperationKey.memberRestore]: z.object({ kind: z.literal("member"), code: z.literal("restored"), memberId: z.string().min(1) }).strict(),
  [BrowserOperationKey.memberRemove]: z.object({ kind: z.literal("member"), code: z.literal("removed"), memberId: z.string().min(1) }).strict(),
  [BrowserOperationKey.memberRoleUpdate]: z.object({ kind: z.literal("member"), code: z.literal("role_updated"), memberId: z.string().min(1), role: z.enum(["admin", "parent", "caretaker", "read_only"]) }).strict(),
  [BrowserOperationKey.memberSuspend]: z.object({ kind: z.literal("member"), code: z.literal("suspended"), memberId: z.string().min(1) }).strict(),
  [BrowserOperationKey.notificationPreferenceSave]: z.object({
    kind: z.literal("notification_preference"),
    code: z.literal("ok"),
    revision: z.number().int().positive(),
    status: z.literal("active"),
    externalDeliveryEnabled: z.boolean()
  }).strict(),
  [BrowserOperationKey.apiKeyRevoke]: z.object({
    kind: z.literal("api_key"),
    code: z.enum(["revoked", "already_revoked"])
  }).strict(),
  [BrowserOperationKey.plannedScheduleSave]: z.object({
    kind: z.literal("planned_schedule"),
    code: z.literal("ok"),
    babyId: z.string().min(1),
    revision: z.number().int().positive(),
    itemCount: z.number().int().nonnegative()
  }).strict()
};

function terminalOutcomeSchemaFor(operationKey: BrowserOperationKey) {
  const schema = terminalOutcomeSchemas[operationKey];
  if (!schema) throw new Error("browser_operation_adapter_unavailable");
  return schema;
}

export type BrowserOperationResult =
  | { status: "open"; operationId: string; bindingId: string }
  | { status: "prepared"; operationId: string; code: "operation_prepared" }
  | { status: "pending"; operationId: string; code?: "operation_unknown" }
  | { status: "completed"; operationId: string; outcome: Record<string, unknown> }
  | { status: "rejected" | "stale"; operationId: string; code: string }
  | { status: "expired"; operationId: string; code: "operation_result_expired" | "operation_abandoned" };

export type BrowserOperationContext = HouseholdContext & { sessionId: string };

type BrowserOperationTransaction = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw"> & {
  session: { findFirst: any };
  household: { findFirst: any };
  baby: { findFirst: any };
  householdMember: { findFirst: any };
  browserOperationBinding: { create: any; findFirst: any; update: any; delete: any };
  browserMutationOperation: { create: any; findUnique: any; update: any };
  browserMutationOperationTombstone: { findUnique: any };
  browserOperationReservationTombstone: { create: any; findUnique: any };
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function browserIntentFingerprint(intent: unknown) {
  return createHash("sha256").update(canonicalJson(intent)).digest("hex");
}

export function assertBrowserOperationId(value: unknown) {
  return operationIdSchema.parse(value);
}

export function createServerBrowserOperationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return `bmo_${Array.from(randomBytes(26), (byte) => alphabet[byte & 31]).join("")}`;
}

export function browserOperationFailureResult(operationId: unknown, error: unknown): Exclude<BrowserOperationResult, { status: "prepared" }> | null {
  const parsedOperationId = operationIdSchema.safeParse(operationId);
  if (!parsedOperationId.success || !(error instanceof Error)) return null;
  if (error.message === "idempotency_conflict") {
    return { status: "rejected", operationId: parsedOperationId.data, code: "idempotency_conflict" };
  }
  if (error.message === "forbidden") {
    return { status: "stale", operationId: parsedOperationId.data, code: "stale_context" };
  }
  if (error.message === "not_found") {
    return { status: "stale", operationId: parsedOperationId.data, code: "stale_target" };
  }
  if (error.message === "baby_inactive") {
    return { status: "stale", operationId: parsedOperationId.data, code: "inactive_baby" };
  }
  if (error.message === "browser_operation_adapter_unavailable" || error.message === "operation_integrity_error") {
    return { status: "rejected", operationId: parsedOperationId.data, code: "operation_integrity_error" };
  }
  return null;
}

/**
 * Everyday browser operations bind to the caller's live session. Requiring a *fresh* sign-in here
 * made every activity, timer, calendar and household-preference mutation fail with
 * fresh_authentication_required ten minutes after signing in. Sensitive operations keep their own
 * freshness checks at the point of use (API keys, admin invites, leaving a household, and the
 * global security flows for password, email and recovery), so this context stays ordinary.
 */
async function requireSessionBoundUser() {
  const session = await getSession();
  if (!session?.user?.id || !session.session?.id) throw new Error("unauthenticated");
  return session;
}

async function getBrowserOperationContextForBabyScope(babyId: unknown, includeInactive: boolean): Promise<BrowserOperationContext> {
  const session = await requireSessionBoundUser();
  const ctx = await getEffectiveHouseholdContext();
  if (session.user.id !== ctx.userId) throw new Error("forbidden");
  const parsedBabyId = z.string().min(1).parse(babyId);
  const baby = await prisma.baby.findFirst({
    where: { id: parsedBabyId, householdId: ctx.householdId, deletedAt: null, ...(includeInactive ? {} : { inactiveAt: null }) },
    select: { id: true }
  });
  if (!baby) throw new Error("not_found");
  return { ...ctx, sessionId: session.session.id };
}

export function getBrowserOperationContextForBaby(babyId: unknown) {
  return getBrowserOperationContextForBabyScope(babyId, true);
}

export function getBrowserOperationContextForLifecycleBaby(babyId: unknown) {
  return getBrowserOperationContextForBabyScope(babyId, true);
}

export async function getBrowserOperationContextForHousehold(): Promise<BrowserOperationContext> {
  const session = await requireSessionBoundUser();
  const ctx = await getEffectiveHouseholdContext();
  if (session.user.id !== ctx.userId) throw new Error("forbidden");
  return { ...ctx, sessionId: session.session.id };
}

function exactBindingMatches(
  binding: {
    sessionId: string;
    actorUserId: string;
    actorMemberId: string;
    operationKey: BrowserOperationKey;
    openingFingerprint: string | null;
    persistenceVersion: number;
    targetKind: BrowserOperationTargetKind | null;
    targetId: string | null;
    babyId: string | null;
  },
  ctx: BrowserOperationContext,
  input: {
    operationKey: BrowserOperationKey;
    openingFingerprint: string;
    targetKind: BrowserOperationTargetKind;
    targetId?: string;
    babyId?: string;
  }
) {
  return (
    binding.sessionId === ctx.sessionId &&
    binding.actorUserId === ctx.userId &&
    binding.actorMemberId === ctx.memberId &&
    binding.operationKey === input.operationKey &&
    binding.persistenceVersion === 2 &&
    binding.openingFingerprint === input.openingFingerprint &&
    binding.targetKind === input.targetKind &&
    binding.targetId === (input.targetId ?? null) &&
    binding.babyId === (input.babyId ?? null)
  );
}

function submitBindingMatches(
  binding: {
    sessionId: string;
    actorUserId: string;
    actorMemberId: string;
    operationKey: BrowserOperationKey;
    openingFingerprint: string | null;
    persistenceVersion: number;
    babyId: string | null;
  },
  ctx: BrowserOperationContext,
  input: { operationKey: BrowserOperationKey; babyId?: string }
) {
  return binding.sessionId === ctx.sessionId &&
    binding.actorUserId === ctx.userId &&
    binding.actorMemberId === ctx.memberId &&
    binding.operationKey === input.operationKey &&
    binding.persistenceVersion === 2 &&
    typeof binding.openingFingerprint === "string" &&
    binding.babyId === (input.babyId ?? null);
}

async function lockCurrentActor(tx: BrowserOperationTransaction, ctx: BrowserOperationContext) {
  await tx.$queryRaw`SELECT "id" FROM "lock_actor_session_for_operation"(${ctx.userId}, ${ctx.sessionId})`;
  const session = await tx.session.findFirst({
    where: { id: ctx.sessionId, userId: ctx.userId, expiresAt: { gt: new Date() } }
  });
  if (!session) throw new Error("forbidden");
  await tx.$queryRaw`SELECT "id" FROM "HouseholdMember" WHERE "id" = ${ctx.memberId} AND "householdId" = ${ctx.householdId} FOR UPDATE`;
  const actor = await tx.householdMember.findFirst({
    where: { id: ctx.memberId, householdId: ctx.householdId, userId: ctx.userId, disabledAt: null, deletedAt: null }
  });
  if (!actor) throw new Error("forbidden");
  return { ...ctx, role: actor.role } as BrowserOperationContext;
}

async function lockBabyForOperation(tx: BrowserOperationTransaction, ctx: BrowserOperationContext, babyId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Baby" WHERE "id" = ${babyId} AND "householdId" = ${ctx.householdId} AND "deletedAt" IS NULL FOR UPDATE`;
  const baby = await tx.baby.findFirst({ where: { id: babyId, householdId: ctx.householdId, deletedAt: null } });
  if (!baby) throw new Error("not_found");
  return baby;
}

async function lockHouseholdForOperation(tx: BrowserOperationTransaction, ctx: BrowserOperationContext) {
  await tx.$queryRaw`SELECT "id" FROM "Household" WHERE "id" = ${ctx.householdId} AND "deletedAt" IS NULL FOR UPDATE`;
  const household = await tx.household.findFirst({ where: { id: ctx.householdId, deletedAt: null } });
  if (!household) throw new Error("not_found");
  return household;
}

function householdBindingMatches(
  binding: {
    sessionId: string;
    actorUserId: string;
    actorMemberId: string;
    operationKey: BrowserOperationKey;
    persistenceVersion: number;
    protocolVersion: BrowserOperationProtocolVersion;
    targetKind: BrowserOperationTargetKind | null;
    targetId: string | null;
    babyId: string | null;
  },
  ctx: BrowserOperationContext,
  input: { operationKey: BrowserOperationKey; targetKind: BrowserOperationTargetKind; targetId?: string }
) {
  return binding.sessionId === ctx.sessionId &&
    binding.actorUserId === ctx.userId &&
    binding.actorMemberId === ctx.memberId &&
    binding.operationKey === input.operationKey &&
    binding.persistenceVersion === 2 &&
    binding.protocolVersion === BrowserOperationProtocolVersion.browserV2 &&
    binding.targetKind === input.targetKind &&
    binding.targetId === (input.targetId ?? null) &&
    binding.babyId === null;
}

async function householdReservationTombstoneResult(
  db: BrowserOperationTransaction,
  ctx: BrowserOperationContext,
  operationId: string,
  operationKey: BrowserOperationKey
): Promise<Extract<BrowserOperationResult, { status: "expired" }> | null> {
  const tombstone = await db.browserOperationReservationTombstone.findUnique({
    where: { householdId_operationId: { householdId: ctx.householdId, operationId } }
  });
  if (!tombstone) return null;
  if (tombstone.sessionId !== ctx.sessionId ||
      tombstone.actorUserId !== ctx.userId ||
      tombstone.actorMemberId !== ctx.memberId ||
      tombstone.operationKey !== operationKey) {
    throw new Error("not_found");
  }
  if (tombstone.terminalCode !== "operation_abandoned" && tombstone.terminalCode !== "operation_result_expired") {
    throw new Error("operation_integrity_error");
  }
  return { status: "expired", operationId, code: tombstone.terminalCode };
}

export async function issueHouseholdBrowserOperation(input: {
  ctx: BrowserOperationContext;
  operationId: unknown;
  operationKey: BrowserOperationKey;
  targetKind: BrowserOperationTargetKind;
  targetId?: string;
  permission: Parameters<typeof requirePermission>[1];
  preActorLock?: (tx: Prisma.TransactionClient) => Promise<void>;
  reauthorize?: (tx: Prisma.TransactionClient, ctx: BrowserOperationContext) => Promise<void>;
  targetSnapshot: (tx: Prisma.TransactionClient, ctx: BrowserOperationContext) => Promise<Record<string, unknown>> | Record<string, unknown>;
}): Promise<BrowserOperationResult> {
  const operationId = input.operationId === undefined ? createServerBrowserOperationId() : assertBrowserOperationId(input.operationId);
  const operationKey = browserOperationKeySchema.parse(input.operationKey);
  terminalOutcomeSchemaFor(operationKey);
  const expiresAt = new Date(Date.now() + browserOperationLeaseMs);
  const openResult = (bindingId: string): Extract<BrowserOperationResult, { status: "open" }> => ({ status: "open", operationId, bindingId });

  const issueOrReplay = async (transaction: Prisma.TransactionClient, recoverOnly = false): Promise<BrowserOperationResult> => {
    const db = transaction as unknown as BrowserOperationTransaction;
    await db.$executeRaw`SELECT "lock_household_browser_operation_identity"(${input.ctx.householdId}, ${operationId})`;
    await input.preActorLock?.(transaction);
    const ctx = await lockCurrentActor(db, input.ctx);
    requirePermission(ctx, input.permission);
    await input.reauthorize?.(transaction, ctx);
    const existing = await db.browserOperationBinding.findFirst({
      where: { householdId: ctx.householdId, operationId },
      include: { operation: true }
    });
    if (existing) {
      if (!householdBindingMatches(existing, ctx, input)) throw new Error("idempotency_conflict");
      return existing.operation ? browserOperationResultFromPersistence(existing.operation) : openResult(existing.id);
    }
    const tombstone = await db.browserMutationOperationTombstone.findUnique({
      where: { householdId_operationId: { householdId: ctx.householdId, operationId } }
    });
    if (tombstone) {
      if (tombstone.actorUserId === ctx.userId && tombstone.actorMemberId === ctx.memberId) {
        return { status: "expired", operationId, code: "operation_result_expired" };
      }
      throw new Error("not_found");
    }
    const reservationTombstone = await householdReservationTombstoneResult(db, ctx, operationId, operationKey);
    if (reservationTombstone) return reservationTombstone;
    if (recoverOnly) throw new Error("idempotency_conflict");

    await lockHouseholdForOperation(db, ctx);
    const targetSnapshot = await input.targetSnapshot(transaction, ctx);
    const openingFingerprint = browserIntentFingerprint({
      version: 2,
      operationKey,
      householdId: ctx.householdId,
      memberId: ctx.memberId,
      babyId: null,
      targetKind: input.targetKind,
      targetId: input.targetId ?? null,
      opening: targetSnapshot
    });
    const binding = await db.browserOperationBinding.create({
      data: {
        sessionId: ctx.sessionId,
        actorUserId: ctx.userId,
        actorMemberId: ctx.memberId,
        householdId: ctx.householdId,
        operationId,
        operationKey,
        legacyIntentFingerprint: null,
        openingFingerprint,
        persistenceVersion: 2,
        targetKind: input.targetKind,
        targetId: input.targetId ?? null,
        babyId: null,
        targetSnapshot,
        protocolVersion: BrowserOperationProtocolVersion.browserV2,
        expiresAt
      }
    });
    return openResult(binding.id);
  };

  return runSerializableWithRetry(async () => {
    try {
      return await prisma.$transaction((tx) => issueOrReplay(tx), { isolationLevel: "Serializable" });
    } catch (error) {
      if (!isBrowserOperationBindingUniqueError(error)) throw error;
      return prisma.$transaction((tx) => issueOrReplay(tx, true), { isolationLevel: "Serializable" });
    }
  });
}

export async function abandonHouseholdBrowserOperation(input: {
  ctx: BrowserOperationContext;
  operationId: unknown;
}): Promise<Extract<BrowserOperationResult, { status: "expired" }>> {
  const operationId = assertBrowserOperationId(input.operationId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (transaction) => {
        const db = transaction as unknown as BrowserOperationTransaction;
        await db.$executeRaw`SELECT "lock_household_browser_operation_identity"(${input.ctx.householdId}, ${operationId})`;
        const lockedCtx = await lockCurrentActor(db, input.ctx);
        await db.$queryRaw`SELECT "id" FROM "BrowserOperationBinding" WHERE "householdId" = ${lockedCtx.householdId} AND "operationId" = ${operationId} FOR UPDATE`;
        const binding = await db.browserOperationBinding.findFirst({
          where: { householdId: lockedCtx.householdId, operationId },
          include: { operation: true }
        });
        if (!binding || binding.actorUserId !== lockedCtx.userId || binding.actorMemberId !== lockedCtx.memberId || binding.sessionId !== lockedCtx.sessionId) {
          throw new Error("not_found");
        }
        if (binding.operation || binding.state !== "open") throw new Error("not_found");
        await db.browserOperationReservationTombstone.create({
          data: {
            householdId: binding.householdId,
            operationId: binding.operationId,
            operationKey: binding.operationKey,
            sessionId: binding.sessionId,
            actorUserId: binding.actorUserId,
            actorMemberId: binding.actorMemberId,
            openingFingerprint: binding.openingFingerprint,
            terminalCode: "operation_abandoned",
            createdAt: binding.issuedAt,
            terminalAt: new Date()
          }
        });
        await db.browserOperationBinding.delete({ where: { id: binding.id } });
        return { status: "expired", operationId, code: "operation_abandoned" };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (!isSerializableWriteConflict(error) || attempt === 2) throw error;
    }
  }
  throw new Error("operation_serialization_retry_exhausted");
}

export async function issueBrowserOperation(input: {
  ctx: BrowserOperationContext;
  operationId: unknown;
  operationKey: BrowserOperationKey;
  opening: unknown;
  babyId: string;
  targetKind: BrowserOperationTargetKind;
  targetId?: string;
  permission: Parameters<typeof requirePermission>[1];
  allowInactiveTarget?: boolean;
  targetSnapshot?: (tx: Prisma.TransactionClient, ctx: BrowserOperationContext, baby: { id: string; inactiveAt: Date | null; updatedAt: Date }) => Promise<Record<string, unknown>> | Record<string, unknown>;
  validate?: (tx: Prisma.TransactionClient, ctx: BrowserOperationContext, baby: { id: string; inactiveAt: Date | null; updatedAt: Date }) => Promise<void>;
}): Promise<BrowserOperationResult> {
  const operationId = input.operationId === undefined ? createServerBrowserOperationId() : assertBrowserOperationId(input.operationId);
  const operationKey = browserOperationKeySchema.parse(input.operationKey);
  terminalOutcomeSchemaFor(operationKey);
  const openingFingerprint = browserIntentFingerprint({
    version: 2,
    operationKey,
    householdId: input.ctx.householdId,
    memberId: input.ctx.memberId,
    babyId: input.babyId,
    targetKind: input.targetKind,
    targetId: input.targetId ?? null,
    opening: input.opening
  });
  const expiresAt = new Date(Date.now() + browserOperationLeaseMs);
  const openResult = (bindingId: string): Extract<BrowserOperationResult, { status: "open" }> => ({ status: "open", operationId, bindingId });

  const issueOrReplay = async (tx: Prisma.TransactionClient, recoverOnly = false): Promise<BrowserOperationResult> => {
    const db = tx as unknown as BrowserOperationTransaction;
    await db.$executeRaw`SELECT "lock_household_browser_operation_identity"(${input.ctx.householdId}, ${operationId})`;
    const ctx = await lockCurrentActor(db, input.ctx);
    requirePermission(ctx, input.permission);

    const existing = await db.browserOperationBinding.findFirst({
      where: { householdId: ctx.householdId, operationId },
      include: { operation: true }
    });
    if (existing) {
      if (!exactBindingMatches(existing, ctx, {
        operationKey,
        openingFingerprint,
        targetKind: input.targetKind,
        targetId: input.targetId,
        babyId: input.babyId
      })) {
        throw new Error("idempotency_conflict");
      }
      if (existing.protocolVersion !== BrowserOperationProtocolVersion.browserV2) throw new Error("not_found");
      return existing.operation
        ? browserOperationResultFromPersistence(existing.operation)
        : openResult(existing.id);
    }
    const tombstone = await db.browserMutationOperationTombstone.findUnique({
      where: { householdId_operationId: { householdId: ctx.householdId, operationId } }
    });
    if (tombstone) {
      if (tombstone.actorUserId === ctx.userId && tombstone.actorMemberId === ctx.memberId) {
        return { status: "expired", operationId, code: "operation_result_expired" };
      }
      throw new Error("not_found");
    }
    const reservationTombstone = await householdReservationTombstoneResult(db, ctx, operationId, operationKey);
    if (reservationTombstone) return reservationTombstone;
    if (recoverOnly) throw new Error("idempotency_conflict");

    const baby = await lockBabyForOperation(db, ctx, input.babyId);
    if (baby.inactiveAt && !input.allowInactiveTarget) throw new Error("baby_inactive");
    await input.validate?.(tx, ctx, baby);

    const binding = await db.browserOperationBinding.create({
      data: {
        sessionId: ctx.sessionId,
        actorUserId: ctx.userId,
        actorMemberId: ctx.memberId,
        householdId: ctx.householdId,
        operationId,
        operationKey,
        legacyIntentFingerprint: null,
        openingFingerprint,
        persistenceVersion: 2,
        targetKind: input.targetKind,
        targetId: input.targetId ?? null,
        babyId: input.babyId,
        targetSnapshot: (await input.targetSnapshot?.(tx, ctx, baby)) ?? {},
        protocolVersion: BrowserOperationProtocolVersion.browserV2,
        expiresAt
      }
    });
    return openResult(binding.id);
  };

  return runSerializableWithRetry(async () => {
    try {
      return await prisma.$transaction((tx) => issueOrReplay(tx), { isolationLevel: "Serializable" });
    } catch (error) {
      if (!isBrowserOperationBindingUniqueError(error)) throw error;
      return prisma.$transaction((tx) => issueOrReplay(tx, true), { isolationLevel: "Serializable" });
    }
  });
}

async function runSerializableWithRetry<T>(operation: () => Promise<T>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSerializableWriteConflict(error) || attempt === 2) throw error;
    }
  }
  throw new Error("operation_serialization_retry_exhausted");
}

function isSerializableWriteConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown; message?: unknown }; message?: unknown };
  return candidate.code === "P2034" ||
    (candidate.code === "P2010" && candidate.meta?.code === "40001") ||
    (typeof candidate.message === "string" && candidate.message.includes("could not serialize access"));
}

function isBrowserOperationBindingUniqueError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown; database_error?: unknown }; message?: unknown };
  const exactComposite = candidate.code === "P2002" && Array.isArray(candidate.meta?.target) && candidate.meta.target.length === 2 && candidate.meta.target[0] === "householdId" && candidate.meta.target[1] === "operationId";
  const reservationGuard = candidate.code === "P2004" && typeof candidate.meta?.database_error === "string" && candidate.meta.database_error.includes("browser_operation_reservation_identity_already_owned");
  const unknownRequestReservationGuard = typeof candidate.message === "string" && candidate.message.includes("browser_operation_reservation_identity_already_owned");
  return exactComposite || reservationGuard || unknownRequestReservationGuard;
}

export function browserOperationResultFromPersistence(operation: {
  operationId: string;
  status: BrowserMutationOperationStatus;
  outcomeCode: string | null;
  outcomeSnapshot: unknown;
}) : BrowserOperationResult {
  if (operation.status === "pending" || operation.status === "unknown") {
    return { status: "pending", operationId: operation.operationId };
  }
  if (operation.status === "completed") {
    if (!operation.outcomeSnapshot || typeof operation.outcomeSnapshot !== "object" || Array.isArray(operation.outcomeSnapshot)) {
      throw new Error("not_found");
    }
    return { status: "completed", operationId: operation.operationId, outcome: operation.outcomeSnapshot as Record<string, unknown> };
  }
  if (!operation.outcomeCode) throw new Error("not_found");
  return { status: operation.status, operationId: operation.operationId, code: operation.outcomeCode };
}

async function persistTerminalOperation(
  db: BrowserOperationTransaction,
  binding: { id: string; householdId: string; operationId: string },
  result: Extract<BrowserOperationResult, { status: "completed" | "rejected" | "stale" }>
) {
  const data = result.status === "completed"
    ? {
        status: BrowserMutationOperationStatus.completed,
        outcomeVersion: 1,
        outcomeKind: String(result.outcome.kind ?? "unknown"),
        outcomeCode: String(result.outcome.code ?? "ok"),
        outcomeSnapshot: { operationId: binding.operationId, ...result.outcome },
        terminalAt: new Date()
      }
    : {
        status: result.status === "stale" ? BrowserMutationOperationStatus.stale : BrowserMutationOperationStatus.rejected,
        outcomeVersion: 1,
        outcomeKind: result.status,
        outcomeCode: result.code,
        outcomeSnapshot: Prisma.DbNull,
        terminalAt: new Date()
      };
  const operation = await db.browserMutationOperation.update({
    where: { householdId_operationId: { householdId: binding.householdId, operationId: binding.operationId } },
    data
  });
  await db.browserOperationBinding.update({ where: { id: binding.id }, data: { state: "terminal" } });
  return browserOperationResultFromPersistence(operation);
}

function staleResult(operationId: string, error: unknown): { status: "stale"; operationId: string; code: string } | null {
  const message = error instanceof Error ? error.message : "";
  if (message === "forbidden") return { status: "stale", operationId, code: "stale_context" };
  if (message === "not_found") return { status: "stale", operationId, code: "stale_target" };
  if (message === "baby_inactive") return { status: "stale", operationId, code: "inactive_baby" };
  if (message === "stale_revision") return { status: "stale", operationId, code: "stale_revision" };
  if (message === "state_conflict") return { status: "stale", operationId, code: "state_conflict" };
  return null;
}

export async function executeHouseholdBrowserOperation<T extends Record<string, unknown>>(input: {
  ctx: BrowserOperationContext;
  operationId: unknown;
  operationKey: BrowserOperationKey;
  intent: unknown;
  targetKind: BrowserOperationTargetKind;
  targetId?: string;
  permission: Parameters<typeof requirePermission>[1];
  preActorLock?: (tx: Prisma.TransactionClient) => Promise<void>;
  reauthorize?: (tx: Prisma.TransactionClient, ctx: BrowserOperationContext) => Promise<void>;
  validate?: (
    tx: Prisma.TransactionClient,
    ctx: BrowserOperationContext,
    binding: { targetSnapshot: unknown }
  ) => Promise<void>;
  execute: (
    tx: Prisma.TransactionClient,
    ctx: BrowserOperationContext,
    binding: { targetSnapshot: unknown }
  ) => Promise<T>;
}): Promise<BrowserOperationResult> {
  const operationId = assertBrowserOperationId(input.operationId);
  const operationKey = browserOperationKeySchema.parse(input.operationKey);
  const outcomeSchema = terminalOutcomeSchemaFor(operationKey);
  let committedThisInvocation = false;

  const result: BrowserOperationResult = await runSerializableWithRetry(() => prisma.$transaction(async (transaction) => {
    committedThisInvocation = false;
    const db = transaction as unknown as BrowserOperationTransaction;
    await db.$executeRaw`SELECT "lock_household_browser_operation_identity"(${input.ctx.householdId}, ${operationId})`;
    await db.$queryRaw`SELECT "id" FROM "BrowserOperationBinding" WHERE "householdId" = ${input.ctx.householdId} AND "operationId" = ${operationId} FOR UPDATE`;
    const binding = await db.browserOperationBinding.findFirst({
      where: { householdId: input.ctx.householdId, operationId },
      include: { operation: true }
    });
    if (!binding) {
      const lockedCtx = await lockCurrentActor(db, input.ctx);
      requirePermission(lockedCtx, input.permission);
      const reservationTombstone = await householdReservationTombstoneResult(db, lockedCtx, operationId, operationKey);
      if (reservationTombstone) return reservationTombstone;
      throw new Error("not_found");
    }
    if (!householdBindingMatches(binding, input.ctx, input)) throw new Error("not_found");
    await input.preActorLock?.(transaction);

    const lockedCtx = await lockCurrentActor(db, input.ctx);
    requirePermission(lockedCtx, input.permission);
    await input.reauthorize?.(transaction, lockedCtx);
    if (!householdBindingMatches(binding, lockedCtx, input)) throw new Error("forbidden");
    await lockHouseholdForOperation(db, lockedCtx);

    if (binding.state === "submitted" && !binding.operation) throw new Error("operation_integrity_error");
    if (binding.operation && binding.state === "open") throw new Error("operation_integrity_error");
    if (!binding.operation && (binding.state !== "open" || binding.expiresAt <= new Date())) {
      await db.browserOperationBinding.update({ where: { id: binding.id }, data: { state: "expired" } });
      return { status: "stale", operationId, code: "stale_context" };
    }

    const intentFingerprint = browserIntentFingerprint({ openingFingerprint: binding.openingFingerprint, payload: input.intent });
    if (binding.operation && binding.operation.intentFingerprint !== intentFingerprint) throw new Error("idempotency_conflict");
    if (binding.operation && binding.operation.status !== "pending" && binding.operation.status !== "unknown") {
      return browserOperationResultFromPersistence(binding.operation);
    }
    if (binding.operation) return { status: "pending", operationId, code: "operation_unknown" };

    const operationData = {
      bindingId: binding.id,
      householdId: binding.householdId,
      operationId: binding.operationId,
      operationKey: binding.operationKey,
      actorUserId: binding.actorUserId,
      actorMemberId: binding.actorMemberId,
      openingFingerprint: binding.openingFingerprint,
      intentFingerprint,
      persistenceVersion: 2,
      targetKind: binding.targetKind,
      targetId: binding.targetId,
      babyId: null
    };
    let operation: { operationId: string; status: BrowserMutationOperationStatus; outcomeCode: string | null; outcomeSnapshot: unknown } | null = null;
    try {
      await input.validate?.(transaction, lockedCtx, binding);
      operation = await db.browserMutationOperation.create({ data: operationData });
      await db.browserOperationBinding.update({ where: { id: binding.id }, data: { state: "submitted" } });
      const outcome = outcomeSchema.parse(await input.execute(transaction, lockedCtx, binding));
      committedThisInvocation = true;
      return persistTerminalOperation(db, binding, { status: "completed", operationId, outcome });
    } catch (error) {
      const stale = staleResult(operationId, error);
      if (!stale) throw error;
      if (!operation) {
        operation = await db.browserMutationOperation.create({ data: operationData });
        await db.browserOperationBinding.update({ where: { id: binding.id }, data: { state: "submitted" } });
      }
      return persistTerminalOperation(db, binding, stale);
    }
  }, { isolationLevel: "Serializable" }));
  if (result.status === "completed" && committedThisInvocation) await recordQualifyingGlobalSessionUseAfterSuccess(prisma, input.ctx, "cubby_owned_non_get_mutation");
  return result;
}

export async function executeBrowserOperation<T extends Record<string, unknown>>(input: {
  ctx: BrowserOperationContext;
  operationId: unknown;
  operationKey: BrowserOperationKey;
  intent: unknown;
  babyId: string;
  permission: Parameters<typeof requirePermission>[1];
  allowInactiveTarget?: boolean;
  validate?: (tx: Prisma.TransactionClient, ctx: BrowserOperationContext, baby: { id: string; inactiveAt: Date | null; updatedAt: Date }, binding: { targetSnapshot: unknown }) => Promise<void>;
  execute: (tx: Prisma.TransactionClient, ctx: BrowserOperationContext, baby: { id: string; inactiveAt: Date | null; updatedAt: Date }) => Promise<T>;
}): Promise<BrowserOperationResult> {
  const operationId = assertBrowserOperationId(input.operationId);
  const operationKey = browserOperationKeySchema.parse(input.operationKey);
  const outcomeSchema = terminalOutcomeSchemaFor(operationKey);
  let committedThisInvocation = false;

  const result: BrowserOperationResult = await runSerializableWithRetry(() => prisma.$transaction(async (tx) => {
    committedThisInvocation = false;
    const db = tx as unknown as BrowserOperationTransaction;
    await db.$executeRaw`SELECT "lock_household_browser_operation_identity"(${input.ctx.householdId}, ${operationId})`;
    await db.$queryRaw`SELECT "id" FROM "BrowserOperationBinding" WHERE "householdId" = ${input.ctx.householdId} AND "operationId" = ${operationId} FOR UPDATE`;
    const binding = await db.browserOperationBinding.findFirst({
      where: { householdId: input.ctx.householdId, operationId },
      include: { operation: true }
    });
    if (!binding) {
      const lockedCtx = await lockCurrentActor(db, input.ctx);
      requirePermission(lockedCtx, input.permission);
      const reservationTombstone = await householdReservationTombstoneResult(db, lockedCtx, operationId, operationKey);
      if (reservationTombstone) return reservationTombstone;
      throw new Error("not_found");
    }
    if (!submitBindingMatches(binding, input.ctx, { operationKey, babyId: input.babyId })) {
      throw new Error("not_found");
    }
    const lockedCtx = await lockCurrentActor(db, input.ctx);
    requirePermission(lockedCtx, input.permission);
    if (!submitBindingMatches(binding, lockedCtx, { operationKey, babyId: input.babyId })) {
      throw new Error("forbidden");
    }
    if (binding.protocolVersion !== BrowserOperationProtocolVersion.browserV2 ||
        binding.persistenceVersion !== 2 || !binding.openingFingerprint) {
      throw new Error("not_found");
    }
    if (binding.state === "submitted" && !binding.operation) throw new Error("not_found");
    if (binding.operation && binding.state === "open") throw new Error("not_found");
    if (!binding.operation && (binding.state !== "open" || binding.expiresAt <= new Date())) {
      await db.browserOperationBinding.update({ where: { id: binding.id }, data: { state: "expired" } });
      return { status: "stale", operationId, code: "stale_context" };
    }
    const intentFingerprint = browserIntentFingerprint({ openingFingerprint: binding.openingFingerprint, payload: input.intent });
    if (binding.operation && binding.operation.intentFingerprint !== intentFingerprint) throw new Error("idempotency_conflict");
    if (binding.operation && binding.operation.status !== "pending" && binding.operation.status !== "unknown") {
      return browserOperationResultFromPersistence(binding.operation);
    }
    let operation = binding.operation;
    const operationData = {
      bindingId: binding.id,
      householdId: binding.householdId,
      operationId: binding.operationId,
      operationKey: binding.operationKey,
      actorUserId: binding.actorUserId,
      actorMemberId: binding.actorMemberId,
      openingFingerprint: binding.openingFingerprint,
      intentFingerprint,
      persistenceVersion: 2,
      targetKind: binding.targetKind,
      targetId: binding.targetId,
      babyId: binding.babyId
    };
    try {
      const baby = await lockBabyForOperation(db, lockedCtx, input.babyId);
      if (baby.inactiveAt && !input.allowInactiveTarget) throw new Error("baby_inactive");
      await input.validate?.(tx, lockedCtx, baby, binding);
      operation ??= await db.browserMutationOperation.create({ data: operationData });
      if (!binding.operation) {
        await db.browserOperationBinding.update({ where: { id: binding.id }, data: { state: "submitted" } });
      }
      const outcome = outcomeSchema.parse(await input.execute(tx, lockedCtx, baby));
      committedThisInvocation = true;
      return persistTerminalOperation(db, binding, { status: "completed", operationId, outcome });
    } catch (error) {
      const stale = staleResult(operationId, error);
      if (!stale) throw error;
      if (!operation) {
        operation = await db.browserMutationOperation.create({ data: operationData });
        await db.browserOperationBinding.update({ where: { id: binding.id }, data: { state: "submitted" } });
      }
      return persistTerminalOperation(db, binding, stale);
    }
  }, { isolationLevel: "Serializable" }));
  if (result.status === "completed" && committedThisInvocation) await recordQualifyingGlobalSessionUseAfterSuccess(prisma, input.ctx, "cubby_owned_non_get_mutation");
  return result;
}
