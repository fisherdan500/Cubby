import type { Prisma } from "@prisma/client";
import type { BrowserOperationContext } from "@/server/services/browser-operations";

/** Same session-before-membership boundary as ordinary browser mutations. */
export async function lockPhotoWriteActor(tx: Prisma.TransactionClient, ctx: BrowserOperationContext) {
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
  return { ...ctx, role: actor.role };
}
