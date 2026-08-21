import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import type { HouseholdContext } from "@/server/auth/context";

const auditActionSchema = z.enum([
  "activity.create",
  "activity.delete",
  "activity.timer.pause",
  "activity.timer.resume",
  "activity.timer.stop",
  "activity.undo",
  "activity.update",
  "api_key.create",
  "api_key.revoke",
  "baby.create",
  "baby.deactivate",
  "baby.reactivate",
  "backup.recovery.authorize",
  "backup.recovery.target.provision",
  "backup.restore",
  "calendar_event.create",
  "export.csv",
  "invite.accept",
  "invite.conflict",
  "invite.create",
  "invite.emergency_revoke",
  "invite.emergency_revoke_all",
  "invite.expire",
  "invite.revoke",
  "invite.rotate",
  "member.admin.grant",
  "member.remove",
  "member.restore",
  "member.self_leave",
  "member.suspend",
  "notification.preference.save",
  "settings.appearance.update",
  "settings.units.update",
  "webhook.create",
  "webhook.delete"
]);

const activityAuditPayloadSchema = z.object({
  type: z.string().min(1).max(80).optional(),
  timerState: z.string().min(1).max(80).optional(),
  source: z.string().min(1).max(80).optional(),
  deletedAt: z.string().datetime().nullable().optional()
}).strip();

function minimizeAuditPayload(action: z.infer<typeof auditActionSchema>, payload: Prisma.InputJsonValue | undefined) {
  if (payload === undefined) return undefined;
  if (action.startsWith("activity.")) {
    return activityAuditPayloadSchema.parse(payload) as Prisma.InputJsonValue;
  }
  return payload;
}

export async function writeAudit(
  ctx: HouseholdContext,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
  },
  db: Pick<Prisma.TransactionClient, "auditEvent"> = prisma
) {
  const action = auditActionSchema.safeParse(input.action);
  if (!action.success) throw new Error("audit_action_unclassified");
  const before = minimizeAuditPayload(action.data, input.before);
  const after = minimizeAuditPayload(action.data, input.after);
  await db.auditEvent.create({
    data: {
      householdId: ctx.householdId,
      actorUserId: ctx.userId,
      actorMemberId: ctx.memberId,
      action: action.data,
      entityType: input.entityType,
      entityId: input.entityId,
      before,
      after
    }
  });
}
