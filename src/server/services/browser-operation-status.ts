import { BrowserOperationKey, HouseholdRole, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext } from "@/server/auth/context";
import { assertFreshSession, getSession } from "@/server/auth/session";
import {
  abandonHouseholdBrowserOperation,
  assertBrowserOperationId,
  browserOperationResultFromPersistence,
  type BrowserOperationResult
} from "@/server/services/browser-operations";

type StatusTransaction = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw"> & {
  session: { findFirst: any };
  householdMember: { findFirst: any };
  browserOperationBinding: { findFirst: any };
  browserMutationOperationTombstone: { findUnique: any };
  browserOperationReservationTombstone: { findUnique: any };
};

export async function abandonCurrentHouseholdBrowserOperation(rawOperationId: unknown) {
  const operationId = assertBrowserOperationId(rawOperationId);
  const ctx = await getEffectiveHouseholdContext();
  const authSession = await getSession();
  if (!authSession?.user || !authSession.session || authSession.user.id !== ctx.userId) throw new Error("unauthenticated");
  return abandonHouseholdBrowserOperation({ ctx: { ...ctx, sessionId: authSession.session.id }, operationId });
}

export async function getHouseholdBrowserOperationStatus(rawOperationId: unknown): Promise<BrowserOperationResult> {
  const operationId = assertBrowserOperationId(rawOperationId);
  const ctx = await getEffectiveHouseholdContext();
  const authSession = await getSession();
  if (!authSession?.user || !authSession.session || authSession.user.id !== ctx.userId) throw new Error("unauthenticated");

  return prisma.$transaction(async (transaction) => {
    const tx = transaction as unknown as StatusTransaction;
    await tx.$executeRaw`SELECT "lock_household_browser_operation_identity"(${ctx.householdId}, ${operationId})`;
    await tx.$queryRaw`SELECT "id" FROM "lock_actor_session_for_operation"(${ctx.userId}, ${authSession.session.id})`;
    const currentSession = await tx.session.findFirst({ where: { id: authSession.session.id, userId: ctx.userId, expiresAt: { gt: new Date() } }, select: { id: true } });
    if (!currentSession) throw new Error("unauthenticated");
    await tx.$queryRaw`SELECT "id" FROM "HouseholdMember" WHERE "id" = ${ctx.memberId} AND "householdId" = ${ctx.householdId} FOR UPDATE`;
    const currentMember = await tx.householdMember.findFirst({ where: { id: ctx.memberId, householdId: ctx.householdId, userId: ctx.userId, disabledAt: null, deletedAt: null }, select: { id: true, role: true } });
    if (!currentMember) throw new Error("not_found");
    const requireApiKeyStatusAuthority = (operationKey: unknown) => {
      if (operationKey !== BrowserOperationKey.apiKeyRevoke) return;
      assertFreshSession(authSession);
      if (currentMember.role !== HouseholdRole.owner) throw new Error("not_found");
    };

    const binding = await tx.browserOperationBinding.findFirst({
      where: { householdId: ctx.householdId, operationId },
      include: { operation: true }
    });
    if (binding) {
      requireApiKeyStatusAuthority(binding.operationKey);
      if (binding.actorUserId !== ctx.userId || binding.actorMemberId !== ctx.memberId || binding.sessionId !== authSession.session.id) {
        throw new Error("not_found");
      }
      if (!binding.operation) {
        if (binding.state === "expired" || binding.state === "revoked") {
          return { status: "expired", operationId, code: "operation_result_expired" };
        }
        return { status: "prepared", operationId, code: "operation_prepared" };
      }
      const result = browserOperationResultFromPersistence(binding.operation);
      return result.status === "pending"
        ? { status: "pending", operationId, code: "operation_unknown" }
        : result;
    }

    const tombstone = await tx.browserMutationOperationTombstone.findUnique({
      where: { householdId_operationId: { householdId: ctx.householdId, operationId } }
    });
    if (tombstone && tombstone.actorUserId === ctx.userId && tombstone.actorMemberId === ctx.memberId) {
      requireApiKeyStatusAuthority(tombstone.operationKey);
      return { status: "expired", operationId, code: "operation_result_expired" };
    }
    const reservationTombstone = await tx.browserOperationReservationTombstone.findUnique({
      where: { householdId_operationId: { householdId: ctx.householdId, operationId } }
    });
    if (!reservationTombstone || reservationTombstone.sessionId !== authSession.session.id || reservationTombstone.actorUserId !== ctx.userId || reservationTombstone.actorMemberId !== ctx.memberId) {
      throw new Error("not_found");
    }
    requireApiKeyStatusAuthority(reservationTombstone.operationKey);
    return {
      status: "expired",
      operationId,
      code: reservationTombstone.terminalCode === "operation_abandoned" ? "operation_abandoned" : "operation_result_expired"
    };
  }, { isolationLevel: "Serializable" });
}
