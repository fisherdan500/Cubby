import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/server/auth/session";
import { assertBrowserOperationId, type BrowserOperationResult } from "@/server/services/browser-operations";
import { accountOperationResultFromPersistence } from "@/server/services/account-appearance";

type AccountStatusTransaction = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw"> & {
  session: { findFirst: any };
  user: { findFirst: any };
  accountOperationBinding: { findFirst: any };
  accountMutationOperationTombstone: { findUnique: any };
  accountOperationReservationTombstone: { findUnique: any };
};

export async function getAccountBrowserOperationStatus(rawOperationId: unknown): Promise<BrowserOperationResult> {
  const operationId = assertBrowserOperationId(rawOperationId);
  const authSession = await getSession();
  if (!authSession?.user || !authSession.session) throw new Error("unauthenticated");
  const context = { userId: authSession.user.id, sessionId: authSession.session.id };

  return prisma.$transaction(async (transaction) => {
    const tx = transaction as unknown as AccountStatusTransaction;
    await tx.$executeRaw`SELECT "lock_account_browser_operation_identity"(${context.userId}, ${operationId})`;
    await tx.$queryRaw`SELECT "id" FROM "lock_actor_session_for_operation"(${context.userId}, ${context.sessionId})`;
    const currentSession = await tx.session.findFirst({
      where: { id: context.sessionId, userId: context.userId, expiresAt: { gt: new Date() } },
      select: { id: true, userId: true }
    });
    if (!currentSession) throw new Error("unauthenticated");
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${context.userId} FOR UPDATE`;
    const currentUser = await tx.user.findFirst({ where: { id: context.userId }, select: { id: true } });
    if (!currentUser) throw new Error("unauthenticated");

    const binding = await tx.accountOperationBinding.findFirst({
      where: { userId: context.userId, operationId },
      include: { operation: true }
    });
    if (binding) {
      if (binding.userId !== context.userId || binding.sessionId !== context.sessionId) {
        throw new Error("not_found");
      }
      if (!binding.operation) {
        if (binding.state === "expired" || binding.state === "revoked") {
          return { status: "expired", operationId, code: "operation_result_expired" };
        }
        return { status: "prepared", operationId, code: "operation_prepared" };
      }
      const result = accountOperationResultFromPersistence(binding.operation);
      return result.status === "pending"
        ? { status: "pending", operationId, code: "operation_unknown" }
        : result;
    }

    const tombstone = await tx.accountMutationOperationTombstone.findUnique({
      where: { userId_operationId: { userId: context.userId, operationId } }
    });
    if (tombstone && tombstone.userId === context.userId) {
      return { status: "expired", operationId, code: "operation_result_expired" };
    }
    const reservationTombstone = await tx.accountOperationReservationTombstone.findUnique({
      where: { userId_operationId: { userId: context.userId, operationId } }
    });
    if (!reservationTombstone || reservationTombstone.sessionId !== context.sessionId || reservationTombstone.userId !== context.userId) throw new Error("not_found");
    return {
      status: "expired",
      operationId,
      code: reservationTombstone.terminalCode === "operation_abandoned" ? "operation_abandoned" : "operation_result_expired"
    };
  }, { isolationLevel: "Serializable" });
}
