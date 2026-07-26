import { createHash, randomBytes } from "crypto";
import { HouseholdRole, InviteStatus, Prisma } from "@prisma/client";
import {
  canAssignHouseholdRole,
  canManageHouseholdRole
} from "@/domain/roles";
import { prisma } from "@/lib/db/prisma";
import { inviteSchema, memberRoleSchema } from "@/lib/validation/onboarding";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { requireUser } from "@/server/auth/session";
import { writeAudit } from "@/server/services/audit";
import { PLATFORM_SIGNUP_POLICY_LOCK_ID } from "@/server/services/platform-constants";

export function hashInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createInvite(raw: unknown) {
  const requestContext = await getHouseholdContext();
  requirePermission(requestContext, "invite.create");
  const input = inviteSchema.parse(raw);
  const token = randomBytes(32).toString("base64url");

  return prisma.$transaction(async (tx) => {
    const { ctx } = await lockMemberMutation(tx, requestContext, requestContext.memberId);
    requirePermission(ctx, "invite.create");
    if (!canAssignHouseholdRole(ctx.role, input.role)) throw new Error("forbidden");

    const invite = await tx.invite.create({
      data: {
        householdId: ctx.householdId,
        email: input.email.toLowerCase(),
        role: input.role as HouseholdRole,
        tokenHash: hashInviteToken(token),
        invitedByUserId: ctx.userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      },
      include: { household: true }
    });
    await writeAudit(ctx, {
      action: "invite.create",
      entityType: "invite",
      entityId: invite.id,
      after: { email: invite.email, role: invite.role, expiresAt: invite.expiresAt }
    }, tx);
    return { ...invite, acceptUrl: `/invite/${token}` };
  });
}

export async function getInviteByToken(token: string) {
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashInviteToken(token) },
    include: { household: true }
  });
  if (!invite) return null;
  if (invite.status !== InviteStatus.pending || invite.expiresAt < new Date()) return null;
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

  return prisma.$transaction(async (tx) => {
    const invite = await lockInviteByToken(tx, token);
    if (!invite || invite.status !== InviteStatus.pending || invite.expiresAt < new Date()) {
      throw new Error("not_found");
    }
    if (invite.email.toLowerCase() !== user.email.toLowerCase()) throw new Error("forbidden");

    const existing = await tx.householdMember.findUnique({
      where: {
        householdId_userId: {
          householdId: invite.householdId,
          userId: user.id
        }
      }
    });
    let member;
    if (existing?.deletedAt) {
      member = await tx.householdMember.update({
        where: { id: existing.id },
        data: { role: invite.role, deletedAt: null }
      });
    } else if (existing) {
      member = existing;
    } else {
      member = await tx.householdMember.create({
        data: {
          householdId: invite.householdId,
          userId: user.id,
          role: invite.role,
          displayName: user.name
        }
      });
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
    return member;
  });
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
        where: { status: InviteStatus.pending },
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
