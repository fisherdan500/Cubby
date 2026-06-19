import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { HouseholdContext } from "@/server/auth/context";

export async function writeAudit(
  ctx: HouseholdContext,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
  }
) {
  await prisma.auditEvent.create({
    data: {
      householdId: ctx.householdId,
      actorUserId: ctx.userId,
      actorMemberId: ctx.memberId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: input.before,
      after: input.after
    }
  });
}
