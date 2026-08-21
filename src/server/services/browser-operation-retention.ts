import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

const dayMs = 24 * 60 * 60 * 1000;
const terminalRetentionMs = 30 * dayMs;

function isRetentionSerializationConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown }; message?: unknown };
  return candidate.code === "P2034" ||
    (candidate.code === "P2010" && candidate.meta?.code === "40001") ||
    (typeof candidate.message === "string" && candidate.message.includes("could not serialize access"));
}

type RetentionTransaction = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw"> & {
  browserMutationOperation: { count: any; findMany: any };
  browserOperationBinding: { findMany: any; updateMany: any; deleteMany: any };
  browserOperationReservationTombstone: { create: any };
  accountMutationOperation: { count: any; findMany: any };
  accountOperationBinding: { findMany: any; updateMany: any; deleteMany: any };
  accountOperationReservationTombstone: { create: any };
};

export type BrowserOperationRetentionScopeResult = {
  unresolvedAlertCount: number;
  compactedCount: number;
  deletedBindingCount: number;
};

export type BrowserOperationRetentionResult = {
  household: BrowserOperationRetentionScopeResult;
  account: BrowserOperationRetentionScopeResult;
};

export async function runBrowserOperationRetention({
  now = new Date(),
  batchSize = 100
}: {
  now?: Date;
  batchSize?: number;
} = {}): Promise<BrowserOperationRetentionResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error("validation_error");
  const unresolvedBefore = new Date(now.getTime() - dayMs);
  const terminalBefore = new Date(now.getTime() - terminalRetentionMs);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await prisma.$transaction(async (transaction) => {
    const tx = transaction as unknown as RetentionTransaction;
    const [householdUnresolved, accountUnresolved] = await Promise.all([
      tx.browserMutationOperation.count({
        where: { status: { in: ["pending", "unknown"] }, createdAt: { lte: unresolvedBefore } }
      }),
      tx.accountMutationOperation.count({
        where: { status: { in: ["pending", "unknown"] }, createdAt: { lte: unresolvedBefore } }
      })
    ]);

    const householdTerminal = await tx.browserMutationOperation.findMany({
      where: { status: { in: ["completed", "rejected", "stale"] }, terminalAt: { lte: terminalBefore } },
      select: { householdId: true, operationId: true },
      orderBy: [{ terminalAt: "asc" }, { householdId: "asc" }, { operationId: "asc" }],
      take: batchSize
    });
    const accountTerminal = await tx.accountMutationOperation.findMany({
      where: { status: { in: ["completed", "rejected", "stale"] }, terminalAt: { lte: terminalBefore } },
      select: { userId: true, operationId: true },
      orderBy: [{ terminalAt: "asc" }, { userId: "asc" }, { operationId: "asc" }],
      take: batchSize
    });

    let householdCompacted = 0;
    for (const operation of householdTerminal) {
      const rows = await tx.$queryRaw<Array<{ compacted: boolean }>>`
        SELECT "compact_household_browser_operation"(${operation.householdId}, ${operation.operationId}, ${now}::timestamp without time zone) AS compacted
      `;
      if (rows[0]?.compacted) householdCompacted += 1;
    }
    let accountCompacted = 0;
    for (const operation of accountTerminal) {
      const rows = await tx.$queryRaw<Array<{ compacted: boolean }>>`
        SELECT "compact_account_browser_operation"(${operation.userId}, ${operation.operationId}, ${now}::timestamp without time zone) AS compacted
      `;
      if (rows[0]?.compacted) accountCompacted += 1;
    }

    await expireHouseholdOpenBindings(tx, now, batchSize);
    await expireAccountOpenBindings(tx, now, batchSize);
    const householdDeleted = await deleteOldBindings(
      tx,
      "household",
      tx.browserOperationBinding,
      terminalBefore,
      batchSize
    );
    const accountDeleted = await deleteOldBindings(
      tx,
      "account",
      tx.accountOperationBinding,
      terminalBefore,
      batchSize
    );

    return {
      household: {
        unresolvedAlertCount: householdUnresolved,
        compactedCount: householdCompacted,
        deletedBindingCount: householdDeleted
      },
      account: {
        unresolvedAlertCount: accountUnresolved,
        compactedCount: accountCompacted,
        deletedBindingCount: accountDeleted
      }
    };
      }, { isolationLevel: "Serializable" });
    } catch (error) {
      if (attempt === 0 && isRetentionSerializationConflict(error)) continue;
      throw error;
    }
  }
  throw new Error("browser_operation_retention_retry_exhausted");
}

async function expireHouseholdOpenBindings(tx: RetentionTransaction, now: Date, batchSize: number) {
  const bindings = await tx.browserOperationBinding.findMany({
    where: { state: "open", persistenceVersion: 2, protocolVersion: "browserV2", openingFingerprint: { not: null }, expiresAt: { lte: now }, operation: null },
    select: { id: true, householdId: true, operationId: true },
    orderBy: [{ householdId: "asc" }, { operationId: "asc" }],
    take: batchSize
  });
  for (const binding of bindings) {
    await tx.$executeRaw`SELECT "lock_household_browser_operation_identity"(${binding.householdId}, ${binding.operationId})`;
    await tx.browserOperationBinding.updateMany({ where: { id: binding.id, state: "open", persistenceVersion: 2, protocolVersion: "browserV2", openingFingerprint: { not: null }, operation: null }, data: { state: "expired" } });
  }
}

async function expireAccountOpenBindings(tx: RetentionTransaction, now: Date, batchSize: number) {
  const bindings = await tx.accountOperationBinding.findMany({
    where: { state: "open", persistenceVersion: 2, protocolVersion: "browserV2", expiresAt: { lte: now }, operation: null },
    select: { id: true, userId: true, operationId: true },
    orderBy: [{ userId: "asc" }, { operationId: "asc" }],
    take: batchSize
  });
  for (const binding of bindings) {
    await tx.$executeRaw`SELECT "lock_account_browser_operation_identity"(${binding.userId}, ${binding.operationId})`;
    await tx.accountOperationBinding.updateMany({ where: { id: binding.id, state: "open", persistenceVersion: 2, protocolVersion: "browserV2", operation: null }, data: { state: "expired" } });
  }
}

async function deleteOldBindings(
  tx: RetentionTransaction,
  scope: "household" | "account",
  model: { findMany: any; deleteMany: any },
  terminalBefore: Date,
  batchSize: number
) {
  const isHousehold = scope === "household";
  const bindings = await model.findMany({
    where: {
      state: { in: ["expired", "revoked"] },
      persistenceVersion: 2,
      protocolVersion: "browserV2",
      ...(isHousehold ? { openingFingerprint: { not: null } } : {}),
      updatedAt: { lte: terminalBefore },
      operation: null
    },
    select: isHousehold
      ? { id: true, sessionId: true, householdId: true, operationId: true, operationKey: true, actorUserId: true, actorMemberId: true, openingFingerprint: true, issuedAt: true }
      : { id: true, sessionId: true, userId: true, operationId: true, operationKey: true, openingFingerprint: true, issuedAt: true },
    orderBy: isHousehold
      ? [{ householdId: "asc" }, { operationId: "asc" }]
      : [{ userId: "asc" }, { operationId: "asc" }],
    take: batchSize
  });
  let deletedBindingCount = 0;
  for (const binding of bindings) {
    if (isHousehold) {
      await tx.$executeRaw`SELECT "lock_household_browser_operation_identity"(${binding.householdId}, ${binding.operationId})`;
      await tx.browserOperationReservationTombstone.create({
        data: {
          householdId: binding.householdId,
          operationId: binding.operationId,
          operationKey: binding.operationKey,
          sessionId: binding.sessionId,
          actorUserId: binding.actorUserId,
          actorMemberId: binding.actorMemberId,
          openingFingerprint: binding.openingFingerprint,
          terminalCode: "operation_result_expired",
          createdAt: binding.issuedAt,
          terminalAt: new Date()
        }
      });
    } else {
      await tx.$executeRaw`SELECT "lock_account_browser_operation_identity"(${binding.userId}, ${binding.operationId})`;
      await tx.accountOperationReservationTombstone.create({
        data: {
          userId: binding.userId,
          operationId: binding.operationId,
          operationKey: binding.operationKey,
          sessionId: binding.sessionId,
          openingFingerprint: binding.openingFingerprint,
          terminalCode: "operation_result_expired",
          createdAt: binding.issuedAt,
          terminalAt: new Date()
        }
      });
    }
    const deleted = await model.deleteMany({
      where: { id: binding.id, state: { in: ["expired", "revoked"] }, operation: null }
    });
    deletedBindingCount += deleted.count;
  }
  return deletedBindingCount;
}

export const runHouseholdBrowserOperationRetention = runBrowserOperationRetention;
