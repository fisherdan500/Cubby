import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

const dayMs = 24 * 60 * 60 * 1000;
const terminalRetentionMs = 30 * dayMs;

type RetentionTransaction = Pick<Prisma.TransactionClient, "$queryRaw"> & {
  browserMutationOperation: { count: any; findMany: any };
  browserOperationBinding: { findMany: any; updateMany: any; deleteMany: any };
  accountMutationOperation: { count: any; findMany: any };
  accountOperationBinding: { findMany: any; updateMany: any; deleteMany: any };
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

  return prisma.$transaction(async (transaction) => {
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
        SELECT "compact_household_browser_operation"(${operation.householdId}, ${operation.operationId}, ${now}) AS compacted
      `;
      if (rows[0]?.compacted) householdCompacted += 1;
    }
    let accountCompacted = 0;
    for (const operation of accountTerminal) {
      const rows = await tx.$queryRaw<Array<{ compacted: boolean }>>`
        SELECT "compact_account_browser_operation"(${operation.userId}, ${operation.operationId}, ${now}) AS compacted
      `;
      if (rows[0]?.compacted) accountCompacted += 1;
    }

    await expireHouseholdOpenBindings(tx, now, batchSize);
    await expireAccountOpenBindings(tx, now, batchSize);
    const householdDeleted = await deleteOldBindings(
      tx.browserOperationBinding,
      terminalBefore,
      batchSize
    );
    const accountDeleted = await deleteOldBindings(
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
}

async function expireHouseholdOpenBindings(tx: RetentionTransaction, now: Date, batchSize: number) {
  const bindings = await tx.browserOperationBinding.findMany({
    where: { state: "open", expiresAt: { lte: now }, operation: null },
    select: { id: true, householdId: true, operationId: true },
    orderBy: [{ householdId: "asc" }, { operationId: "asc" }],
    take: batchSize
  });
  for (const binding of bindings) {
    await tx.$queryRaw`SELECT "lock_household_browser_operation_identity"(${binding.householdId}, ${binding.operationId})`;
    await tx.browserOperationBinding.updateMany({ where: { id: binding.id, state: "open", operation: null }, data: { state: "expired" } });
  }
}

async function expireAccountOpenBindings(tx: RetentionTransaction, now: Date, batchSize: number) {
  const bindings = await tx.accountOperationBinding.findMany({
    where: { state: "open", expiresAt: { lte: now }, operation: null },
    select: { id: true, userId: true, operationId: true },
    orderBy: [{ userId: "asc" }, { operationId: "asc" }],
    take: batchSize
  });
  for (const binding of bindings) {
    await tx.$queryRaw`SELECT "lock_account_browser_operation_identity"(${binding.userId}, ${binding.operationId})`;
    await tx.accountOperationBinding.updateMany({ where: { id: binding.id, state: "open", operation: null }, data: { state: "expired" } });
  }
}

async function deleteOldBindings(
  model: { findMany: any; deleteMany: any },
  terminalBefore: Date,
  batchSize: number
) {
  const bindings = await model.findMany({
    where: {
      state: { in: ["expired", "revoked"] },
      updatedAt: { lte: terminalBefore },
      operation: null
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: batchSize
  });
  let deletedBindingCount = 0;
  for (const binding of bindings) {
    const deleted = await model.deleteMany({
      where: { id: binding.id, state: { in: ["expired", "revoked"] }, operation: null }
    });
    deletedBindingCount += deleted.count;
  }
  return deletedBindingCount;
}

export const runHouseholdBrowserOperationRetention = runBrowserOperationRetention;
