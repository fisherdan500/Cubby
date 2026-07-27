import { createHash, randomBytes } from "crypto";
import { HouseholdRole, InviteStatus, Prisma } from "@prisma/client";
import {
  canAssignHouseholdRole,
  canManageHouseholdRole
} from "@/domain/roles";
import { SESSION_FRESH_AGE_SECONDS } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import {
  bulkInviteRevokeSchema,
  inviteSchema,
  memberRoleSchema
} from "@/lib/validation/onboarding";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { requireFreshSession, requireUser } from "@/server/auth/session";
import { writeAudit } from "@/server/services/audit";
import { PLATFORM_SIGNUP_POLICY_LOCK_ID } from "@/server/services/platform-constants";

export function hashInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export const BULK_INVITE_REVOKE_ACKNOWLEDGEMENT = "I_REVOKE_ALL_PENDING_INVITATIONS";

type MembershipState =
  | "absent"
  | "active_same_role"
  | "active_role_conflict"
  | "suspended"
  | "removed";

export function resolveInviteMembershipState(
  member: { role: HouseholdRole; disabledAt: Date | null; deletedAt: Date | null } | null,
  inviteRole: HouseholdRole
): MembershipState {
  if (!member) return "absent";
  if (member.deletedAt) return "removed";
  if (member.disabledAt) return "suspended";
  return member.role === inviteRole ? "active_same_role" : "active_role_conflict";
}

export function resolveInviteExpiry(role: HouseholdRole, requestedHours?: number, now = new Date()) {
  const isAdmin = role === HouseholdRole.admin;
  const defaultHours = isAdmin ? 24 : 24 * 7;
  const maximumHours = isAdmin ? 24 * 7 : 24 * 30;
  const hours = requestedHours ?? defaultHours;

  if (!Number.isInteger(hours) || hours < 1 || hours > maximumHours) {
    throw new Error("invite_expiry_invalid");
  }

  return new Date(now.getTime() + hours * 60 * 60 * 1000);
}

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

export async function createInvite(raw: unknown) {
  const requestContext = await getHouseholdContext();
  requirePermission(requestContext, "invite.create");
  const input = inviteSchema.parse(raw);
  const freshSession = input.role === "admin" ? await requireFreshSession() : null;
  if (freshSession) {
    if (freshSession.user.id !== requestContext.userId) throw new Error("forbidden");
  }
  const token = randomBytes(32).toString("base64url");

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
    const { ctx } = await lockMemberMutation(tx, requestContext, requestContext.memberId);
    requirePermission(ctx, "invite.create");
    if (freshSession) {
      await lockAndRevalidateFreshSession(tx, freshSession);
      if (freshSession.user.id !== ctx.userId) throw new Error("forbidden");
    }
    if (!canAssignHouseholdRole(ctx.role, input.role)) throw new Error("forbidden");
    const expiresAt = resolveInviteExpiry(input.role as HouseholdRole, input.expiresInHours);

    const normalizedEmail = input.email.toLowerCase();
    const rotatedIds = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Invite"
      WHERE "householdId" = ${ctx.householdId}
        AND LOWER(BTRIM("email")) = ${normalizedEmail}
        AND "status" = ${InviteStatus.pending}::"InviteStatus"
      ORDER BY "id"
      FOR UPDATE
    `;
    const rotatedInvites = rotatedIds.length === 0
      ? []
      : await tx.invite.findMany({
          where: { id: { in: rotatedIds.map(({ id }) => id) } },
          orderBy: { id: "asc" }
        });
    const rotatedAt = new Date();
    for (const rotated of rotatedInvites) {
      await tx.invite.update({
        where: { id: rotated.id },
        data: { status: InviteStatus.revoked, revokedAt: rotatedAt }
      });
      await writeAudit(ctx, {
        action: "invite.rotate",
        entityType: "invite",
        entityId: rotated.id,
        before: { email: rotated.email, role: rotated.role, status: rotated.status },
        after: { status: InviteStatus.revoked, revokedAt: rotatedAt }
      }, tx);
    }

    const invite = await tx.invite.create({
      data: {
        householdId: ctx.householdId,
        email: normalizedEmail,
        role: input.role as HouseholdRole,
        tokenHash: hashInviteToken(token),
        invitedByUserId: ctx.userId,
        expiresAt
      },
      include: { household: true }
    });
    await writeAudit(ctx, {
      action: "invite.create",
      entityType: "invite",
      entityId: invite.id,
      after: { email: invite.email, role: invite.role, expiresAt: invite.expiresAt }
    }, tx);
    return {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expiresAt,
      acceptUrl: `/invite/${token}`
    };
  });
}

export async function getInviteByToken(token: string, recipientEmail?: string) {
  if (!recipientEmail) return null;
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: { household: true }
  });
  if (!invite) return null;
  if (invite.status !== InviteStatus.pending || invite.expiresAt <= new Date()) return null;
  if (invite.email.toLowerCase() !== recipientEmail.toLowerCase()) return null;
  return invite;
}

async function lockInviteByToken(tx: Prisma.TransactionClient, token: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Invite"
    WHERE "tokenHash" = ${hashInviteToken(token)}
    FOR UPDATE
  `;
  if (locked.length !== 1) return null;
  return tx.invite.findUnique({ where: { id: locked[0].id } });
}

async function lockInviteById(tx: Prisma.TransactionClient, inviteId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Invite"
    WHERE "id" = ${inviteId}
    FOR UPDATE
  `;
  if (locked.length !== 1) return null;
  return tx.invite.findUnique({ where: { id: locked[0].id } });
}

export async function acceptInvite(token: string) {
  const user = await requireUser();

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
    const invite = await lockInviteByToken(tx, token);
    if (!invite || invite.status !== InviteStatus.pending || invite.expiresAt <= new Date()) {
      throw new Error("not_found");
    }
    if (invite.email.toLowerCase() !== user.email.toLowerCase()) throw new Error("not_found");

    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "HouseholdMember"
      WHERE "householdId" = ${invite.householdId} AND "userId" = ${user.id}
      ORDER BY "id"
      FOR UPDATE
    `;
    const existing = await tx.householdMember.findUnique({
      where: {
        householdId_userId: {
          householdId: invite.householdId,
          userId: user.id
        }
      }
    });
    if (invite.expiresAt <= new Date()) throw new Error("not_found");
    const membershipState = resolveInviteMembershipState(existing, invite.role);
    let member;
    if (membershipState === "removed" && existing) {
      member = await tx.householdMember.update({
        where: { id: existing.id },
        data: { role: invite.role, disabledAt: null, deletedAt: null }
      });
    } else if (membershipState === "active_same_role" && existing) {
      member = existing;
    } else if (membershipState === "absent") {
      member = await tx.householdMember.create({
        data: {
          householdId: invite.householdId,
          userId: user.id,
          role: invite.role,
          displayName: user.name
        }
      });
    } else {
      await tx.invite.update({
        where: { id: invite.id },
        data: { status: InviteStatus.conflicted }
      });
      await tx.auditEvent.create({
        data: {
          householdId: invite.householdId,
          actorUserId: user.id,
          actorMemberId: existing?.id,
          action: "invite.conflict",
          entityType: "invite",
          entityId: invite.id,
          after: { reason: membershipState }
        }
      });
      return { conflict: true } as const;
    }

    await tx.invite.update({
      where: { id: invite.id },
      data: {
        status: InviteStatus.accepted,
        acceptedByUserId: user.id,
        acceptedAt: new Date()
      }
    });
    await tx.auditEvent.create({
      data: {
        householdId: invite.householdId,
        actorUserId: user.id,
        actorMemberId: member.id,
        action: "invite.accept",
        entityType: "invite",
        entityId: invite.id,
        after: { userId: user.id, role: member.role }
      }
    });
    return { member } as const;
  });

  if ("conflict" in result) throw new Error("invite_membership_conflict");
  return result.member;
}

export async function listMembersAndInvites() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "member.manage");
  const household = await prisma.household.findUniqueOrThrow({
    where: { id: ctx.householdId },
    include: {
      members: {
        where: { deletedAt: null },
        include: { user: true },
        orderBy: { joinedAt: "asc" }
      },
      invites: {
        where: { status: InviteStatus.pending, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" }
      }
    }
  });
  return {
    ...household,
    viewerRole: ctx.role,
    viewerMemberId: ctx.memberId
  };
}

export async function updateMemberRole(memberId: string, raw: unknown) {
  const requestContext = await getHouseholdContext();
  requirePermission(requestContext, "member.manage");
  const input = memberRoleSchema.parse(raw);

  return prisma.$transaction(async (tx) => {
    const { ctx, member } = await lockMemberMutation(tx, requestContext, memberId);
    requirePermission(ctx, "member.manage");
    if (member.disabledAt) throw new Error("forbidden");
    if (!canManageHouseholdRole(ctx.role, member.role)) throw new Error("forbidden");
    if (!canAssignHouseholdRole(ctx.role, input.role)) throw new Error("forbidden");
    if (member.role === input.role) return member;

    const updated = await tx.householdMember.update({
      where: { id: member.id },
      data: { role: input.role as HouseholdRole },
      include: { user: true }
    });
    await writeAudit(
      ctx,
      {
        action: input.role === "admin" ? "member.admin.grant" : member.role === HouseholdRole.admin ? "member.admin.revoke" : "member.role.update",
        entityType: "household_member",
        entityId: member.id,
        before: { role: member.role },
        after: { role: updated.role }
      },
      tx
    );
    return updated;
  });
}

export async function removeMember(memberId: string) {
  const requestContext = await getHouseholdContext();
  requirePermission(requestContext, "member.manage");

  return prisma.$transaction(async (tx) => {
    const { ctx, member } = await lockMemberMutation(tx, requestContext, memberId);
    requirePermission(ctx, "member.manage");
    if (member.disabledAt) throw new Error("forbidden");
    if (!canManageHouseholdRole(ctx.role, member.role)) throw new Error("forbidden");

    const removed = await tx.householdMember.update({
      where: { id: member.id },
      data: { deletedAt: new Date() },
      include: { user: true }
    });
    await writeAudit(
      ctx,
      {
        action: "member.remove",
        entityType: "household_member",
        entityId: member.id,
        before: { role: member.role, userId: member.userId },
        after: { deletedAt: removed.deletedAt }
      },
      tx
    );
    return removed;
  });
}

export async function suspendMember(memberId: string, disabledAt = new Date()) {
  const requestContext = await getHouseholdContext();
  requirePermission(requestContext, "member.manage");

  return prisma.$transaction(async (tx) => {
    const { ctx, member } = await lockMemberMutation(tx, requestContext, memberId);
    requirePermission(ctx, "member.manage");
    if (member.id === ctx.memberId || !canManageHouseholdRole(ctx.role, member.role)) {
      throw new Error("forbidden");
    }
    if (member.disabledAt) return member;

    const suspended = await tx.householdMember.update({
      where: { id: member.id },
      data: { disabledAt },
      include: { user: true }
    });
    await tx.session.deleteMany({ where: { userId: member.userId } });
    await writeAudit(
      ctx,
      {
        action: "member.suspend",
        entityType: "household_member",
        entityId: member.id,
        before: { userId: member.userId, role: member.role, disabledAt: null },
        after: { userId: member.userId, role: member.role, disabledAt }
      },
      tx
    );
    return suspended;
  });
}

export async function restoreMember(memberId: string) {
  const requestContext = await getHouseholdContext();
  requirePermission(requestContext, "member.manage");

  return prisma.$transaction(async (tx) => {
    const { ctx, member } = await lockMemberMutation(tx, requestContext, memberId);
    requirePermission(ctx, "member.manage");
    if (member.id === ctx.memberId || !canManageHouseholdRole(ctx.role, member.role)) {
      throw new Error("forbidden");
    }
    if (!member.disabledAt) return member;

    const restored = await tx.householdMember.update({
      where: { id: member.id },
      data: { disabledAt: null },
      include: { user: true }
    });
    await writeAudit(
      ctx,
      {
        action: "member.restore",
        entityType: "household_member",
        entityId: member.id,
        before: { userId: member.userId, role: member.role, disabledAt: member.disabledAt },
        after: { userId: member.userId, role: member.role, disabledAt: null }
      },
      tx
    );
    return restored;
  });
}

export async function revokeInvite(inviteId: string) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "member.manage");

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
    const { ctx: currentCtx } = await lockMemberMutation(tx, ctx, ctx.memberId);
    requirePermission(currentCtx, "member.manage");
    const invite = await lockInviteById(tx, inviteId);
    if (!invite || invite.status !== InviteStatus.pending) throw new Error("not_found");
    if (invite.householdId !== currentCtx.householdId) throw new Error("forbidden");
    if (!canManageHouseholdRole(currentCtx.role, invite.role)) throw new Error("forbidden");

    const revoked = await tx.invite.update({
      where: { id: invite.id },
      data: { status: InviteStatus.revoked, revokedAt: new Date() }
    });
    await writeAudit(currentCtx, {
      action: "invite.revoke",
      entityType: "invite",
      entityId: invite.id,
      before: { email: invite.email, role: invite.role, status: invite.status },
      after: { status: revoked.status, revokedAt: revoked.revokedAt }
    }, tx);
    return revoked;
  });
}

export async function revokeAllPendingInvites(raw: unknown) {
  const input = bulkInviteRevokeSchema.parse(raw);
  if (input.acknowledgement !== BULK_INVITE_REVOKE_ACKNOWLEDGEMENT) {
    throw new Error("bulk_invite_revoke_acknowledgement_required");
  }

  const freshSession = await requireFreshSession();
  const requestContext = await getHouseholdContext();
  if (freshSession.user.id !== requestContext.userId) throw new Error("forbidden");

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
    const { ctx } = await lockMemberMutation(tx, requestContext, requestContext.memberId);
    if (ctx.role !== HouseholdRole.owner) throw new Error("forbidden");
    await lockAndRevalidateFreshSession(tx, freshSession);
    if (freshSession.user.id !== ctx.userId) throw new Error("forbidden");

    const lockedIds = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Invite"
      WHERE "householdId" = ${ctx.householdId}
        AND "status" = ${InviteStatus.pending}::"InviteStatus"
      ORDER BY "id"
      FOR UPDATE
    `;
    if (lockedIds.length === 0) return { revokedCount: 0 };

    const invites = await tx.invite.findMany({
      where: { id: { in: lockedIds.map(({ id }) => id) } },
      orderBy: { id: "asc" }
    });
    const revokedAt = new Date();
    for (const invite of invites) {
      await tx.invite.update({
        where: { id: invite.id },
        data: { status: InviteStatus.revoked, revokedAt }
      });
      await writeAudit(ctx, {
        action: "invite.emergency_revoke",
        entityType: "invite",
        entityId: invite.id,
        before: { email: invite.email, role: invite.role, status: invite.status },
        after: { status: InviteStatus.revoked, revokedAt }
      }, tx);
    }
    await writeAudit(ctx, {
      action: "invite.emergency_revoke_all",
      entityType: "household",
      entityId: ctx.householdId,
      after: { revokedCount: invites.length, revokedAt }
    }, tx);
    return { revokedCount: invites.length };
  });
}

async function lockMemberMutation(
  tx: Prisma.TransactionClient,
  requestContext: Awaited<ReturnType<typeof getHouseholdContext>>,
  memberId: string
) {
  const memberIds = [...new Set([requestContext.memberId, memberId])].sort();
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "HouseholdMember"
    WHERE "id" IN (${Prisma.join(memberIds)})
    ORDER BY "id"
    FOR UPDATE
  `;

  const actor = await tx.householdMember.findUnique({ where: { id: requestContext.memberId } });
  if (
    !actor ||
    actor.householdId !== requestContext.householdId ||
    actor.deletedAt ||
    actor.disabledAt
  ) {
    throw new Error("forbidden");
  }

  const member = await tx.householdMember.findUnique({
    where: { id: memberId },
    include: { user: true }
  });
  if (!member || member.deletedAt) throw new Error("not_found");
  if (member.householdId !== actor.householdId) throw new Error("forbidden");

  return {
    ctx: { ...requestContext, role: actor.role },
    member
  };
}
