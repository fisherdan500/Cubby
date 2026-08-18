import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext } from "@/server/auth/context";
import { getSession } from "@/server/auth/session";
import {
  assertBrowserOperationId,
  browserOperationResultFromPersistence,
  type BrowserOperationResult
} from "@/server/services/browser-operations";

type StatusTransaction = Pick<Prisma.TransactionClient, "$queryRaw"> & {
  session: { findFirst: any };
  householdMember: { findFirst: any };
  browserOperationBinding: { findFirst: any };
  browserMutationOperationTombstone: { findUnique: any };
};

export async function getHouseholdBrowserOperationStatus(rawOperationId: unknown): Promise<BrowserOperationResult> {
  const operationId = assertBrowserOperationId(rawOperationId);
  const ctx = await getEffectiveHouseholdContext();
  const authSession = await getSession();
  if (!authSession?.user || !authSession.session || authSession.user.id !== ctx.userId) throw new Error("unauthenticated");

  return prisma.$transaction(async (transaction) => {
    const tx = transaction as unknown as StatusTransaction;
    await tx.$queryRaw`SELECT "lock_household_browser_operation_identity"(${ctx.householdId}, ${operationId})`;
    await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${authSession.session.id} AND "userId" = ${ctx.userId} FOR UPDATE`;
    const currentSession = await tx.session.findFirst({ where: { id: authSession.session.id, userId: ctx.userId, expiresAt: { gt: new Date() } }, select: { id: true } });
    if (!currentSession) throw new Error("unauthenticated");
    await tx.$queryRaw`SELECT "id" FROM "HouseholdMember" WHERE "id" = ${ctx.memberId} AND "householdId" = ${ctx.householdId} FOR UPDATE`;
    const currentMember = await tx.householdMember.findFirst({ where: { id: ctx.memberId, householdId: ctx.householdId, userId: ctx.userId, disabledAt: null, deletedAt: null }, select: { id: true } });
    if (!currentMember) throw new Error("not_found");

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
