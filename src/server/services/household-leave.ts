import { HouseholdRole, InviteStatus, Prisma, TimerState } from "@prisma/client";
import { z } from "zod";
import { SESSION_FRESH_AGE_SECONDS } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { requireFreshSession, requireUser } from "@/server/auth/session";
import { PLATFORM_SIGNUP_POLICY_LOCK_ID } from "@/server/services/platform-constants";

const leaveInputSchema = z.object({
  householdId: z.string().min(1),
  confirmation: z.string(),
  operationId: z.string().uuid()
}).strict();

export type HouseholdLeaveWarning =
  | "sole_admin"
  | "active_timers"
  | "pending_invitations"
  | "notification_authority"
  | "api_key_authority"
  | "webhook_authority";

async function lockAndRevalidateFreshSession(
  tx: Prisma.TransactionClient,
  freshSession: Awaited<ReturnType<typeof requireFreshSession>>
) {
  const sessions = await tx.$queryRaw<Array<{
    id: string;
    userId: string;
    createdAt: Date;
    expiresAt: Date;
  }>>`
    SELECT "id", "userId", "createdAt", "expiresAt"
    FROM "Session"
    WHERE "id" = ${freshSession.session.id}
    FOR UPDATE
  `;
  const session = sessions[0];
  if (!session || session.userId !== freshSession.user.id || session.expiresAt <= new Date()) {
    throw new Error("unauthenticated");
  }
  if (Date.now() - session.createdAt.getTime() >= SESSION_FRESH_AGE_SECONDS * 1000) {
    throw new Error("fresh_authentication_required");
  }
}

function leaveReceipt(member: {
  id: string;
  householdId: string;
  deletedAt: Date | null;
  closureReason: string | null;
  leaveOperationId: string | null;
}) {
  if (!member.deletedAt || member.closureReason !== "self_left" || !member.leaveOperationId) {
    throw new Error("not_found");
  }
  return {
    operationId: member.leaveOperationId,
    householdId: member.householdId,
    membershipId: member.id,
    leftAt: member.deletedAt,
    reason: "self_left" as const
  };
}

export async function getHouseholdLeaveOptions() {
  const user = await requireUser();
  const memberships = await prisma.householdMember.findMany({
    where: { userId: user.id, deletedAt: null, household: { deletedAt: null } },
    include: { household: { select: { name: true } } },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }]
  });
  return memberships.map((member) => ({
    householdId: member.householdId,
    householdName: member.household.name,
    membershipId: member.id,
    role: member.role,
    suspended: member.disabledAt !== null
  }));
}

export async function getHouseholdLeavePreview(householdId: string) {
  const user = await requireUser();
  const member = await prisma.householdMember.findFirst({
    where: {
      householdId,
      userId: user.id,
      deletedAt: null,
      household: { deletedAt: null }
    },
    include: { household: { select: { name: true } } }
  });
  if (!member) throw new Error("not_found");

  const [
    otherAdmins,
    activeTimers,
    pendingInvitations,
    notificationPreferences,
    pushSubscriptions,
    apiKeysToRevoke,
    webhooksToRetire
  ] = await Promise.all([
    member.role === HouseholdRole.admin
      ? prisma.householdMember.count({
          where: {
            householdId,
            id: { not: member.id },
            role: HouseholdRole.admin,
            disabledAt: null,
            deletedAt: null
          }
        })
      : Promise.resolve(0),
    prisma.activityLog.count({
      where: {
        householdId,
        actorMemberId: member.id,
        deletedAt: null,
        timerState: { in: [TimerState.running, TimerState.paused] }
      }
    }),
    prisma.invite.count({
      where: {
        householdId,
        status: InviteStatus.pending,
        OR: [
          { invitedByUserId: user.id },
          { email: { equals: user.email, mode: "insensitive" } }
        ]
      }
    }),
    prisma.notificationPreference.count({ where: { householdId, userId: user.id } }),
    prisma.pushSubscription.count({ where: { householdId, userId: user.id, deletedAt: null } }),
    prisma.apiKey.count({
      where: {
        householdId,
        revokedAt: null,
        OR: [
          { legacyUnattributed: true },
          { legacyUnattributed: false, delegatedByMemberId: member.id }
        ]
      }
    }),
    prisma.webhookEndpoint.count({
      where: {
        householdId,
        deletedAt: null,
        OR: [
          { legacyUnattributed: true },
          { legacyUnattributed: false, delegatedByMemberId: member.id }
        ]
      }
    })
  ]);

  const warnings: HouseholdLeaveWarning[] = [];
  if (member.role === HouseholdRole.admin && otherAdmins === 0) warnings.push("sole_admin");
  if (activeTimers > 0) warnings.push("active_timers");
  if (pendingInvitations > 0) warnings.push("pending_invitations");
  if (notificationPreferences > 0 || pushSubscriptions > 0) warnings.push("notification_authority");
  if (apiKeysToRevoke > 0) warnings.push("api_key_authority");
  if (webhooksToRetire > 0) warnings.push("webhook_authority");

  return {
    householdId,
    householdName: member.household.name,
    membershipId: member.id,
    role: member.role,
    suspended: member.disabledAt !== null,
    protectedOwner: member.role === HouseholdRole.owner,
    authorityImpact: { apiKeysToRevoke, webhooksToRetire },
    warnings
  };
}

export async function leaveHousehold(raw: unknown) {
  const input = leaveInputSchema.parse(raw);
  const freshSession = await requireFreshSession();
  const leftAt = new Date();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "HouseholdMember"
      WHERE "householdId" = ${input.householdId}
        AND "userId" = ${freshSession.user.id}
        AND "deletedAt" IS NULL
      ORDER BY "id"
      FOR UPDATE
    `;
    await lockAndRevalidateFreshSession(tx, freshSession);

    const completedOperation = await tx.householdMember.findFirst({
      where: { leaveOperationId: input.operationId }
    });
    const member = await tx.householdMember.findFirst({
      where: {
        householdId: input.householdId,
        userId: freshSession.user.id,
        deletedAt: null,
        household: { deletedAt: null }
      },
      include: { household: { select: { name: true } } }
    });
    if (!member) {
      if (
        completedOperation?.householdId === input.householdId
        && completedOperation.userId === freshSession.user.id
        && completedOperation.closureReason === "self_left"
      ) return leaveReceipt(completedOperation);
      throw new Error("not_found");
    }
    if (completedOperation) throw new Error("household_leave_operation_reused");
    if (member.role === HouseholdRole.owner) throw new Error("household_owner_cannot_leave");
    if (input.confirmation !== member.household.name) {
      throw new Error("household_leave_confirmation_mismatch");
    }

    const closed = await tx.householdMember.update({
      where: { id: member.id },
      data: {
        deletedAt: leftAt,
        closureReason: "self_left",
        leaveOperationId: input.operationId
      }
    });
    await tx.apiKey.updateMany({
      where: {
        householdId: input.householdId,
        revokedAt: null,
        OR: [
          { legacyUnattributed: true },
          { legacyUnattributed: false, delegatedByMemberId: member.id }
        ]
      },
      data: { revokedAt: leftAt }
    });
    const retiringEndpoints = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "WebhookEndpoint"
      WHERE "householdId" = ${input.householdId}
        AND "deletedAt" IS NULL
        AND (
          "legacyUnattributed" = TRUE
          OR ("legacyUnattributed" = FALSE AND "delegatedByMemberId" = ${member.id})
        )
      ORDER BY "id"
      FOR UPDATE
    `;
    const retiringEndpointIds = retiringEndpoints.map((endpoint) => endpoint.id);
    if (retiringEndpointIds.length) {
      await tx.webhookDelivery.updateMany({
        where: { endpointId: { in: retiringEndpointIds }, status: "pending" },
        data: { status: "failed", lastError: "endpoint_owner_left", nextAttemptAt: null }
      });
      await tx.webhookEndpoint.updateMany({
        where: { id: { in: retiringEndpointIds } },
        data: { deletedAt: leftAt, enabled: false }
      });
    }
    await tx.invite.updateMany({
      where: {
        householdId: input.householdId,
        status: InviteStatus.pending,
        OR: [
          { invitedByUserId: freshSession.user.id },
          { email: { equals: freshSession.user.email, mode: "insensitive" } }
        ]
      },
      data: { status: InviteStatus.revoked, revokedAt: leftAt }
    });
    await tx.notificationPreference.deleteMany({
      where: { householdId: input.householdId, userId: freshSession.user.id }
    });
    await tx.pushSubscription.updateMany({
      where: {
        householdId: input.householdId,
        userId: freshSession.user.id,
        deletedAt: null
      },
      data: { deletedAt: leftAt }
    });
    await tx.notificationLog.deleteMany({
      where: { householdId: input.householdId, userId: freshSession.user.id }
    });
    const remainingAdministrators = await tx.householdMember.findMany({
      where: {
        householdId: input.householdId,
        id: { not: member.id },
        role: { in: [HouseholdRole.owner, HouseholdRole.admin] },
        disabledAt: null,
        deletedAt: null
      },
      select: { id: true, userId: true },
      orderBy: { id: "asc" }
    });
    const activeRemainingAdministratorUserIds: string[] = [];
    for (const recipient of remainingAdministrators) {
      const lockedRecipient = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "HouseholdMember"
        WHERE "id" = ${recipient.id}
          AND "householdId" = ${input.householdId}
          AND "disabledAt" IS NULL
          AND "deletedAt" IS NULL
        -- A concurrent membership closure owns this row exclusively. Omit the
        -- non-authoritative notice rather than waiting behind an inverse lock.
        FOR SHARE SKIP LOCKED
      `;
      if (lockedRecipient.length) activeRemainingAdministratorUserIds.push(recipient.userId);
    }
    if (activeRemainingAdministratorUserIds.length) {
      await tx.notificationLog.createMany({
        data: activeRemainingAdministratorUserIds.map((userId) => ({
          householdId: input.householdId,
          userId,
          kind: "member_left",
          title: "A member left the household",
          body: null
        }))
      });
    }
    await tx.auditEvent.create({
      data: {
        householdId: input.householdId,
        actorUserId: freshSession.user.id,
        actorMemberId: member.id,
        action: "member.self_leave",
        entityType: "household_member",
        entityId: member.id,
        before: { role: member.role, disabledAt: member.disabledAt },
        after: {
          deletedAt: leftAt,
          closureReason: "self_left",
          leaveOperationId: input.operationId
        }
      }
    });

    return leaveReceipt(closed);
  });
}
