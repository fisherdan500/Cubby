import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

const dayMs = 24 * 60 * 60 * 1000;
const terminalRetentionMs = 30 * dayMs;

type RetentionTransaction = Pick<Prisma.TransactionClient, "$queryRaw"> & {
  browserMutationOperation: { count: any; findMany: any };
  browserOperationBinding: { findMany: any; deleteMany: any };
};

export type HouseholdBrowserOperationRetentionResult = {
  unresolvedAlertCount: number;
  compactedCount: number;
  deletedBindingCount: number;
};

export async function runHouseholdBrowserOperationRetention({
  now = new Date(),
  batchSize = 100
}: {
  now?: Date;
  batchSize?: number;
} = {}): Promise<HouseholdBrowserOperationRetentionResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error("validation_error");
  const unresolvedBefore = new Date(now.getTime() - dayMs);
  const terminalBefore = new Date(now.getTime() - terminalRetentionMs);

  return prisma.$transaction(async (transaction) => {
    const tx = transaction as unknown as RetentionTransaction;
    const unresolvedAlertCount = await tx.browserMutationOperation.count({
      where: { status: { in: ["pending", "unknown"] }, createdAt: { lte: unresolvedBefore } }
    });
    const terminal = await tx.browserMutationOperation.findMany({
      where: {
        status: { in: ["completed", "rejected", "stale"] },
        terminalAt: { lte: terminalBefore }
      },
      select: { householdId: true, operationId: true },
      orderBy: [{ terminalAt: "asc" }, { householdId: "asc" }, { operationId: "asc" }],
      take: batchSize
    });

    let compactedCount = 0;
    for (const operation of terminal) {
      const rows = await tx.$queryRaw<Array<{ compacted: boolean }>>`
        SELECT "compact_household_browser_operation"(
          ${operation.householdId},
          ${operation.operationId},
          ${now}
        ) AS compacted
      `;
      if (rows[0]?.compacted) compactedCount += 1;
    }

    const bindings = await tx.browserOperationBinding.findMany({
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
      const deleted = await tx.browserOperationBinding.deleteMany({
        where: { id: binding.id, state: { in: ["expired", "revoked"] }, operation: null }
      });
      deletedBindingCount += deleted.count;
    }

    return { unresolvedAlertCount, compactedCount, deletedBindingCount };
  }, { isolationLevel: "Serializable" });
}
