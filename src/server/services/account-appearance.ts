import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { appearanceModeSchema, parseAppearanceMode, type AppearanceMode } from "@/domain/appearance";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/server/auth/session";
import {
  assertBrowserOperationId,
  browserIntentFingerprint,
  type BrowserOperationResult
} from "@/server/services/browser-operations";

const accountAppearanceOperationKey = "account.appearance.update" as const;
const accountOperationLeaseMs = 30 * 60 * 1000;
const accountAppearanceSnapshotSchema = z.object({
  appearanceMode: appearanceModeSchema,
  appearanceRevision: z.number().int().nonnegative(),
  schemaVersion: z.literal(1)
}).strict();
const accountAppearanceOutcomeSchema = z.object({
  operationId: z.string(),
  kind: z.literal("account_appearance"),
  code: z.literal("ok"),
  appearanceMode: appearanceModeSchema,
  appearanceRevision: z.number().int().positive()
}).strict();

type AccountTransaction = Pick<Prisma.TransactionClient, "$queryRaw"> & {
  session: { findFirst: any };
  user: { findFirst: any; updateMany: any };
  accountOperationBinding: { findFirst: any; create: any; update: any };
  accountMutationOperation: { create: any; update: any };
  accountMutationOperationTombstone: { findUnique: any };
};

type AccountContext = { sessionId: string; userId: string };

type PersistedAccountOperation = {
  operationId: string;
  status: "pending" | "unknown" | "completed" | "rejected" | "stale";
  outcomeCode: string | null;
  outcomeSnapshot: unknown;
};

export async function getAccountAppearance() {
  const session = await getSession();
  if (!session?.user) throw new Error("unauthenticated");
  const preference = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { appearanceMode: true, appearanceRevision: true }
  });
  if (!preference) throw new Error("unauthenticated");
  return {
    appearanceMode: parseAppearanceMode(preference.appearanceMode),
    appearanceRevision: preference.appearanceRevision
  };
}

export async function getCurrentAuthenticatedAppearanceMode(): Promise<AppearanceMode> {
  const session = await getSession();
  if (!session?.user) return "system";
  const preference = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { appearanceMode: true }
  });
  return parseAppearanceMode(preference?.appearanceMode);
}

type AuthenticatedSession = NonNullable<Awaited<ReturnType<typeof getSession>>>;

async function requireAccountSession(): Promise<AuthenticatedSession> {
  const session = await getSession();
  if (!session?.user || !session.session) throw new Error("unauthenticated");
  return session as AuthenticatedSession;
}

function accountContext(session: AuthenticatedSession): AccountContext {
  return { sessionId: session.session.id, userId: session.user.id };
}

async function lockCurrentAccountActor(tx: AccountTransaction, ctx: AccountContext) {
  await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${ctx.sessionId} AND "userId" = ${ctx.userId} FOR UPDATE`;
  const currentSession = await tx.session.findFirst({
    where: { id: ctx.sessionId, userId: ctx.userId, expiresAt: { gt: new Date() } }
  });
  if (!currentSession) throw new Error("stale_context");
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${ctx.userId} FOR UPDATE`;
  const user = await tx.user.findFirst({
    where: { id: ctx.userId },
    select: { id: true, appearanceMode: true, appearanceRevision: true }
  });
  if (!user) throw new Error("stale_context");
  return {
    id: user.id as string,
    appearanceMode: parseAppearanceMode(user.appearanceMode),
    appearanceRevision: user.appearanceRevision as number
  };
}

function accountOperationResultFromPersistence(operation: PersistedAccountOperation): BrowserOperationResult {
  if (operation.status === "pending" || operation.status === "unknown") {
    return { status: "pending", operationId: operation.operationId, code: "operation_unknown" };
  }
  if (operation.status === "completed") {
    const outcome = accountAppearanceOutcomeSchema.parse(operation.outcomeSnapshot);
    return { status: "completed", operationId: operation.operationId, outcome };
  }
  if (!operation.outcomeCode) throw new Error("operation_integrity_error");
  return { status: operation.status, operationId: operation.operationId, code: operation.outcomeCode };
}

function bindingMatches(binding: {
  sessionId: string;
  userId: string;
  operationKey: string;
  openingFingerprint: string;
  persistenceVersion: number;
  protocolVersion: string;
}, ctx: AccountContext, openingFingerprint?: string) {
  return binding.sessionId === ctx.sessionId &&
    binding.userId === ctx.userId &&
    binding.operationKey === accountAppearanceOperationKey &&
    binding.persistenceVersion === 2 &&
    binding.protocolVersion === "browser_v2" &&
    (!openingFingerprint || binding.openingFingerprint === openingFingerprint);
}

export async function issueAccountAppearanceBrowserOperation(raw: { operationId?: unknown }): Promise<BrowserOperationResult> {
  const operationId = assertBrowserOperationId(raw.operationId);
  const ctx = accountContext(await requireAccountSession());
  const expiresAt = new Date(Date.now() + accountOperationLeaseMs);

  const issueOrReplay = async (transaction: Prisma.TransactionClient, recoverOnly = false): Promise<BrowserOperationResult> => {
    const tx = transaction as unknown as AccountTransaction;
    await tx.$queryRaw`SELECT "lock_account_browser_operation_identity"(${ctx.userId}, ${operationId})`;
    const user = await lockCurrentAccountActor(tx, ctx);
    const opening = {
      version: 2,
      operationKey: accountAppearanceOperationKey,
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      appearanceMode: user.appearanceMode,
      appearanceRevision: user.appearanceRevision,
      schemaVersion: 1
    };
    const openingFingerprint = browserIntentFingerprint(opening);
    const existing = await tx.accountOperationBinding.findFirst({
      where: { userId: ctx.userId, operationId },
      include: { operation: true }
    });
    if (existing) {
      if (!bindingMatches(existing, ctx, openingFingerprint)) throw new Error("idempotency_conflict");
      if (existing.operation) return accountOperationResultFromPersistence(existing.operation);
      return { status: "open", operationId, bindingId: existing.id };
    }
    const tombstone = await tx.accountMutationOperationTombstone.findUnique({
      where: { userId_operationId: { userId: ctx.userId, operationId } }
    });
    if (tombstone) return { status: "expired", operationId, code: "operation_result_expired" };
    if (recoverOnly) throw new Error("idempotency_conflict");
    const binding = await tx.accountOperationBinding.create({
      data: {
        sessionId: ctx.sessionId,
        userId: ctx.userId,
        operationId,
        operationKey: accountAppearanceOperationKey,
        openingFingerprint,
        persistenceVersion: 2,
        targetSnapshot: {
          appearanceMode: user.appearanceMode,
          appearanceRevision: user.appearanceRevision,
          schemaVersion: 1
        },
        protocolVersion: "browser_v2",
        expiresAt,
        state: "open"
      }
    });
    return { status: "open", operationId, bindingId: binding.id };
  };

  try {
    return await prisma.$transaction((tx) => issueOrReplay(tx), { isolationLevel: "Serializable" });
  } catch (error) {
    if (!isAccountBindingUniqueError(error)) throw error;
    return prisma.$transaction((tx) => issueOrReplay(tx, true), { isolationLevel: "Serializable" });
  }
}

function isAccountBindingUniqueError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  return candidate.code === "P2002" && Array.isArray(candidate.meta?.target) &&
    candidate.meta.target[0] === "userId" && candidate.meta.target[1] === "operationId";
}

async function persistAccountTerminal(
  tx: AccountTransaction,
  binding: { id: string; userId: string; operationId: string },
  result: Extract<BrowserOperationResult, { status: "completed" | "rejected" | "stale" }>
) {
  const data = result.status === "completed"
    ? {
        status: "completed",
        outcomeVersion: 2,
        outcomeKind: "account_appearance",
        outcomeCode: "ok",
        outcomeSnapshot: { operationId: binding.operationId, ...result.outcome },
        terminalAt: new Date()
      }
    : {
        status: result.status,
        outcomeVersion: 2,
        outcomeKind: result.status,
        outcomeCode: result.code,
        outcomeSnapshot: null,
        terminalAt: new Date()
      };
  const operation = await tx.accountMutationOperation.update({
    where: { userId_operationId: { userId: binding.userId, operationId: binding.operationId } },
    data
  });
  await tx.accountOperationBinding.update({ where: { id: binding.id }, data: { state: "terminal" } });
  return accountOperationResultFromPersistence(operation);
}

export async function submitAccountAppearanceBrowserOperation(raw: {
  operationId?: unknown;
  appearanceMode?: unknown;
}): Promise<BrowserOperationResult> {
  const operationId = assertBrowserOperationId(raw.operationId);
  const appearanceMode = appearanceModeSchema.parse(raw.appearanceMode);
  const ctx = accountContext(await requireAccountSession());

  return prisma.$transaction(async (transaction) => {
    const tx = transaction as unknown as AccountTransaction;
    await tx.$queryRaw`SELECT "lock_account_browser_operation_identity"(${ctx.userId}, ${operationId})`;
    await lockCurrentAccountActor(tx, ctx);
    const binding = await tx.accountOperationBinding.findFirst({
      where: { userId: ctx.userId, operationId },
      include: { operation: true }
    });
    if (!binding) {
      const tombstone = await tx.accountMutationOperationTombstone.findUnique({
        where: { userId_operationId: { userId: ctx.userId, operationId } }
      });
      if (tombstone) return { status: "expired", operationId, code: "operation_result_expired" } as const;
      throw new Error("not_found");
    }
    if (!bindingMatches(binding, ctx)) throw new Error("stale_context");
    if (!binding.operation && (binding.state !== "open" || binding.expiresAt <= new Date())) {
      await tx.accountOperationBinding.update({ where: { id: binding.id }, data: { state: "expired" } });
      return { status: "stale", operationId, code: "stale_context" } as const;
    }
    if (binding.state === "submitted" && !binding.operation) throw new Error("operation_integrity_error");
    const opening = accountAppearanceSnapshotSchema.parse(binding.targetSnapshot);
    const intentFingerprint = browserIntentFingerprint({
      openingFingerprint: binding.openingFingerprint,
      payload: { appearanceMode }
    });
    if (binding.operation && binding.operation.intentFingerprint !== intentFingerprint) throw new Error("idempotency_conflict");
    if (binding.operation && binding.operation.status !== "pending" && binding.operation.status !== "unknown") {
      return accountOperationResultFromPersistence(binding.operation);
    }
    if (binding.operation) return { status: "pending", operationId, code: "operation_unknown" };

    await tx.accountMutationOperation.create({
      data: {
        bindingId: binding.id,
        userId: binding.userId,
        operationId: binding.operationId,
        operationKey: binding.operationKey,
        openingFingerprint: binding.openingFingerprint,
        intentFingerprint,
        persistenceVersion: 2
      }
    });
    await tx.accountOperationBinding.update({ where: { id: binding.id }, data: { state: "submitted" } });
    const updated = await tx.user.updateMany({
      where: { id: ctx.userId, appearanceRevision: opening.appearanceRevision },
      data: { appearanceMode, appearanceRevision: { increment: 1 } }
    });
    if (updated.count !== 1) {
      return persistAccountTerminal(tx, binding, { status: "stale", operationId, code: "stale_revision" });
    }
    return persistAccountTerminal(tx, binding, {
      status: "completed",
      operationId,
      outcome: {
        kind: "account_appearance",
        code: "ok",
        appearanceMode,
        appearanceRevision: opening.appearanceRevision + 1
      }
    });
  }, { isolationLevel: "Serializable" });
}

export { accountOperationResultFromPersistence };
