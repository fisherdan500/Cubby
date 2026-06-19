import { createHash, randomBytes } from "crypto";
import { HouseholdRole, InviteStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { inviteSchema } from "@/lib/validation/onboarding";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { requireUser } from "@/server/auth/session";
import { writeAudit } from "@/server/services/audit";

export function hashInviteToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createInvite(raw: unknown) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "invite.create");
  const input = inviteSchema.parse(raw);
  const token = randomBytes(32).toString("base64url");
  const invite = await prisma.invite.create({
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
  });
  return {
    ...invite,
    acceptUrl: `/invite/${token}`
  };
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

export async function acceptInvite(token: string) {
  const user = await requireUser();
  const invite = await getInviteByToken(token);
  if (!invite) throw new Error("not_found");

  const member = await prisma.$transaction(async (tx) => {
    const existing = await tx.householdMember.findUnique({
      where: {
        householdId_userId: {
          householdId: invite.householdId,
          userId: user.id
        }
      }
    });
    const nextMember = existing
      ? await tx.householdMember.update({
          where: { id: existing.id },
          data: { role: invite.role, deletedAt: null }
        })
      : await tx.householdMember.create({
          data: {
            householdId: invite.householdId,
            userId: user.id,
            role: invite.role,
            displayName: user.name
          }
        });

    await tx.invite.update({
      where: { id: invite.id },
      data: {
        status: InviteStatus.accepted,
        acceptedByUserId: user.id,
        acceptedAt: new Date()
      }
    });
    return nextMember;
  });

  await prisma.auditEvent.create({
    data: {
      householdId: invite.householdId,
      actorUserId: user.id,
      actorMemberId: member.id,
      action: "invite.accept",
      entityType: "invite",
      entityId: invite.id,
      after: { userId: user.id, role: invite.role }
    }
  });

  return member;
}

export async function listMembersAndInvites() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "activity.read");
  return prisma.household.findUniqueOrThrow({
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
}
