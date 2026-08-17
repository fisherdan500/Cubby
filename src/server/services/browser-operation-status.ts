import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext } from "@/server/auth/context";
import {
  assertBrowserOperationId,
  browserOperationResultFromPersistence,
  type BrowserOperationResult
} from "@/server/services/browser-operations";

type StatusTransaction = Pick<Prisma.TransactionClient, "$queryRaw"> & {
  browserOperationBinding: { findFirst: any };
  browserMutationOperationTombstone: { findUnique: any };
};

export async function getHouseholdBrowserOperationStatus(rawOperationId: unknown): Promise<BrowserOperationResult> {
  const operationId = assertBrowserOperationId(rawOperationId);
  const ctx = await getEffectiveHouseholdContext();

  return prisma.$transaction(async (transaction) => {
    const tx = transaction as unknown as StatusTransaction;
    await tx.$queryRaw`SELECT "lock_household_browser_operation_identity"(${ctx.householdId}, ${operationId})`;

    const binding = await tx.browserOperationBinding.findFirst({
      where: { householdId: ctx.householdId, operationId },
      include: { operation: true }
    });
    if (binding) {
      if (binding.actorUserId !== ctx.userId || binding.actorMemberId !== ctx.memberId || !binding.operation) {
        throw new Error("not_found");
      }
      const result = browserOperationResultFromPersistence(binding.operation);
      return result.status === "pending"
        ? { status: "pending", operationId, code: "operation_unknown" }
        : result;
    }

    const tombstone = await tx.browserMutationOperationTombstone.findUnique({
      where: { householdId_operationId: { householdId: ctx.householdId, operationId } }
    });
    if (!tombstone || tombstone.actorUserId !== ctx.userId || tombstone.actorMemberId !== ctx.memberId) {
      throw new Error("not_found");
    }
    return { status: "expired", operationId, code: "operation_result_expired" };
  }, { isolationLevel: "Serializable" });
}
