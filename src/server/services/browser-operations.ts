import { createHash } from "node:crypto";
import { BrowserMutationOperationStatus, BrowserOperationKey, type Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireFreshSession } from "@/server/auth/session";
import { requirePermission, type HouseholdContext } from "@/server/auth/context";

export const browserOperationLeaseMs = 30 * 60 * 1000;

const operationIdPattern = /^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const operationIdSchema = z.string().regex(operationIdPattern);
const browserOperationKeySchema = z.nativeEnum(BrowserOperationKey);
const terminalOutcomeSchemas = {
  [BrowserOperationKey.calendarEventCreate]: z.object({
    kind: z.literal("calendar_event"),
    code: z.literal("ok"),
    eventId: z.string().min(1)
  }).strict(),
  [BrowserOperationKey.dashboardWarningDismiss]: z.object({
    kind: z.literal("warning_dismissed"),
    code: z.literal("ok"),
    warningKey: z.string().min(1)
  }).strict()
};

export type BrowserOperationResult =
  | { status: "pending"; operationId: string }
  | { status: "completed"; operationId: string; outcome: Record<string, unknown> }
  | { status: "rejected" | "stale"; operationId: string; code: string };

export type BrowserOperationContext = HouseholdContext & { sessionId: string };

type BrowserOperationTransaction = Pick<Prisma.TransactionClient, "$queryRaw"> & {
  session: { findFirst: any };
  baby: { findFirst: any };
  householdMember: { findFirst: any };
  browserOperationBinding: { create: any; findFirst: any; update: any };
  browserMutationOperation: { create: any; findUnique: any; update: any };
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

export function browserOperationFailureResult(operationId: unknown, error: unknown): BrowserOperationResult | null {
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
  return null;
}

export async function getBrowserOperationContextForBaby(babyId: unknown): Promise<BrowserOperationContext> {
  const session = await requireFreshSession();
  const parsedBabyId = z.string().min(1).parse(babyId);
  const baby = await prisma.baby.findFirst({
    where: { id: parsedBabyId, deletedAt: null },
    select: { householdId: true }
  });
  if (!baby) throw new Error("not_found");

  const member = await prisma.householdMember.findFirst({
    where: {
      id: { not: "" },
      userId: session.user.id,
      householdId: baby.householdId,
      disabledAt: null,
      deletedAt: null,
      household: { deletedAt: null }
    },
    select: { id: true, householdId: true, role: true }
  });
  if (!member) throw new Error("not_found");
  return { userId: session.user.id, sessionId: session.session.id, householdId: member.householdId, memberId: member.id, role: member.role };
}

function exactBindingMatches(
  binding: {
    sessionId: string;
    actorUserId: string;
    actorMemberId: string;
    operationKey: BrowserOperationKey;
    intentFingerprint: string;
    babyId: string | null;
  },
  ctx: BrowserOperationContext,
  input: { operationKey: BrowserOperationKey; intentFingerprint: string; babyId?: string }
) {
  return (
    binding.sessionId === ctx.sessionId &&
    binding.actorUserId === ctx.userId &&
    binding.actorMemberId === ctx.memberId &&
    binding.operationKey === input.operationKey &&
    binding.intentFingerprint === input.intentFingerprint &&
    binding.babyId === (input.babyId ?? null)
  );
}

async function lockCurrentActor(tx: BrowserOperationTransaction, ctx: BrowserOperationContext) {
  await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${ctx.sessionId} AND "userId" = ${ctx.userId} FOR UPDATE`;
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

export async function issueBrowserOperation(input: {
  ctx: BrowserOperationContext;
  operationId: unknown;
  operationKey: BrowserOperationKey;
  intent: unknown;
  babyId: string;
  permission: Parameters<typeof requirePermission>[1];
  validate?: (tx: Prisma.TransactionClient, ctx: BrowserOperationContext, baby: { id: string; inactiveAt: Date | null }) => Promise<void>;
}): Promise<BrowserOperationResult> {
  const operationId = assertBrowserOperationId(input.operationId);
  const operationKey = browserOperationKeySchema.parse(input.operationKey);
  const intentFingerprint = browserIntentFingerprint(input.intent);
  const expiresAt = new Date(Date.now() + browserOperationLeaseMs);

  const issueOrReplay = async (tx: Prisma.TransactionClient, recoverOnly = false) => {
    const db = tx as unknown as BrowserOperationTransaction;
    const ctx = await lockCurrentActor(db, input.ctx);
    requirePermission(ctx, input.permission);
    const baby = await lockBabyForOperation(db, ctx, input.babyId);
    if (baby.inactiveAt) throw new Error("baby_inactive");

    const existing = await db.browserOperationBinding.findFirst({
      where: { householdId: ctx.householdId, operationId },
      include: { operation: true }
    });
    if (existing) {
      if (!exactBindingMatches(existing, ctx, { operationKey, intentFingerprint, babyId: input.babyId })) {
        throw new Error("idempotency_conflict");
      }
      return toBrowserOperationResult(existing.operation);
    }
    if (recoverOnly) throw new Error("idempotency_conflict");

    await input.validate?.(tx, ctx, baby);

    const binding = await db.browserOperationBinding.create({
      data: {
        sessionId: ctx.sessionId,
        actorUserId: ctx.userId,
        actorMemberId: ctx.memberId,
        householdId: ctx.householdId,
        operationId,
        operationKey,
        intentFingerprint,
        babyId: input.babyId,
        expiresAt
      }
    });
    const operation = await db.browserMutationOperation.create({
      data: {
        bindingId: binding.id,
        householdId: ctx.householdId,
        operationId,
        operationKey,
        actorUserId: ctx.userId,
        actorMemberId: ctx.memberId,
        intentFingerprint,
        babyId: input.babyId
      }
    });
    return toBrowserOperationResult(operation);
  };

  try {
    return await prisma.$transaction((tx) => issueOrReplay(tx), { isolationLevel: "Serializable" });
  } catch (error) {
    if (!isBrowserOperationBindingUniqueError(error)) throw error;
    return prisma.$transaction((tx) => issueOrReplay(tx, true), { isolationLevel: "Serializable" });
  }
}

function isBrowserOperationBindingUniqueError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  return candidate.code === "P2002" && Array.isArray(candidate.meta?.target) && candidate.meta.target.length === 2 && candidate.meta.target[0] === "householdId" && candidate.meta.target[1] === "operationId";
}

function toBrowserOperationResult(operation: {
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
        outcomeSnapshot: null,
        terminalAt: new Date()
      };
  const operation = await db.browserMutationOperation.update({
    where: { householdId_operationId: { householdId: binding.householdId, operationId: binding.operationId } },
    data
  });
  await db.browserOperationBinding.update({ where: { id: binding.id }, data: { state: "terminal" } });
  return toBrowserOperationResult(operation);
}

function staleResult(operationId: string, error: unknown): { status: "stale"; operationId: string; code: string } | null {
  const message = error instanceof Error ? error.message : "";
  if (message === "forbidden") return { status: "stale", operationId, code: "stale_context" };
  if (message === "not_found") return { status: "stale", operationId, code: "stale_target" };
  if (message === "baby_inactive") return { status: "stale", operationId, code: "inactive_baby" };
  return null;
}

export async function executeBrowserOperation<T extends Record<string, unknown>>(input: {
  ctx: BrowserOperationContext;
  operationId: unknown;
  operationKey: BrowserOperationKey;
  intent: unknown;
  babyId: string;
  permission: Parameters<typeof requirePermission>[1];
  validate?: (tx: Prisma.TransactionClient, ctx: BrowserOperationContext, baby: { id: string; inactiveAt: Date | null }) => Promise<void>;
  execute: (tx: Prisma.TransactionClient, ctx: BrowserOperationContext, baby: { id: string; inactiveAt: Date | null }) => Promise<T>;
}): Promise<BrowserOperationResult> {
  const operationId = assertBrowserOperationId(input.operationId);
  const operationKey = browserOperationKeySchema.parse(input.operationKey);
  const intentFingerprint = browserIntentFingerprint(input.intent);

  return prisma.$transaction(async (tx) => {
    const db = tx as unknown as BrowserOperationTransaction;
    await db.$queryRaw`SELECT "id" FROM "BrowserOperationBinding" WHERE "householdId" = ${input.ctx.householdId} AND "operationId" = ${operationId} FOR UPDATE`;
    const binding = await db.browserOperationBinding.findFirst({
      where: { householdId: input.ctx.householdId, operationId },
      include: { operation: true }
    });
    if (!binding || !exactBindingMatches(binding, input.ctx, { operationKey, intentFingerprint, babyId: input.babyId })) {
      throw new Error("not_found");
    }
    const lockedCtx = await lockCurrentActor(db, input.ctx);
    requirePermission(lockedCtx, input.permission);
    if (!exactBindingMatches(binding, lockedCtx, { operationKey, intentFingerprint, babyId: input.babyId })) {
      throw new Error("forbidden");
    }
    if (binding.operation.status !== "pending" && binding.operation.status !== "unknown") return toBrowserOperationResult(binding.operation);
    if (binding.state !== "open" || binding.expiresAt <= new Date()) {
      return persistTerminalOperation(db, binding, { status: "stale", operationId, code: "stale_context" });
    }
    try {
      const baby = await lockBabyForOperation(db, lockedCtx, input.babyId);
      if (baby.inactiveAt) throw new Error("baby_inactive");
      await input.validate?.(tx, lockedCtx, baby);
      const outcome = terminalOutcomeSchemas[operationKey].parse(await input.execute(tx, lockedCtx, baby));
      return persistTerminalOperation(db, binding, { status: "completed", operationId, outcome });
    } catch (error) {
      const stale = staleResult(operationId, error);
      if (!stale) throw error;
      return persistTerminalOperation(db, binding, stale);
    }
  }, { isolationLevel: "Serializable" });
}
