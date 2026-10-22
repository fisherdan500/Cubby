import { HouseholdRole, Prisma } from "@prisma/client";
import { z } from "zod";
import { SESSION_FRESH_AGE_SECONDS } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { requireFreshSession, requireUser } from "@/server/auth/session";
import { writeAudit } from "@/server/services/audit";
import { PLATFORM_SIGNUP_POLICY_LOCK_ID } from "@/server/services/platform-constants";

/**
 * Handing a household to someone else.
 *
 * A household has exactly one owner and must never have zero or two, so ownership does not change
 * so much as MOVE, atomically, between two people who each agreed to it:
 *
 *   DEC-PROD-016  the recipient must already be an active member with a verified account. A
 *                 stranger cannot be made owner; they accept a normal invitation first, which is a
 *                 separate operation on purpose.
 *   DEC-PROD-017  the owner authenticates freshly and names the recipient, and the RECIPIENT must
 *                 then accept in-app before anything moves.
 *   DEC-PROD-018  the former owner becomes an administrator -- not removed, not left with nothing.
 *
 * The pending row IS the intermediate state. It grants no authority while it sits there: until the
 * recipient accepts, the owner is still the owner and can cancel. A single-step transfer would let
 * one person hand a household to someone who never agreed to hold it.
 */

const HOUSEHOLD_OWNERSHIP_TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const initiateSchema = z.object({
  householdId: z.string().min(1),
  toMemberId: z.string().min(1),
  confirmation: z.string(),
  operationId: z.string().uuid()
}).strict();

const settleSchema = z.object({
  householdId: z.string().min(1),
  transferId: z.string().min(1),
  operationId: z.string().uuid()
}).strict();

/**
 * Re-read the actor's session INSIDE the transaction and re-check its freshness.
 *
 * The freshness checked at the edge was true when the request arrived; this one is true at the
 * moment authority actually moves. Between those two points a session can be revoked.
 */
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
    FROM "lock_actor_session_for_operation"(${freshSession.user.id}, ${freshSession.session.id})
  `;
  const session = sessions[0];
  if (!session || session.userId !== freshSession.user.id || session.expiresAt <= new Date()) {
    throw new Error("unauthenticated");
  }
  if (Date.now() - session.createdAt.getTime() >= SESSION_FRESH_AGE_SECONDS * 1000) {
    throw new Error("fresh_authentication_required");
  }
}

/** DEC-PROD-016: an active, undeleted member whose account email is verified. */
function eligibleRecipient(member: {
  disabledAt: Date | null;
  deletedAt: Date | null;
  role: string;
  user?: { emailVerified?: boolean | Date | null } | null;
}) {
  if (member.disabledAt || member.deletedAt) return false;
  if (member.role === HouseholdRole.owner) return false;
  return Boolean(member.user?.emailVerified);
}

/**
 * Who this household could be handed to. Owner-only: the list of who could take your household is
 * not information other members need.
 */
export async function getOwnershipTransferRecipients(householdId: string) {
  const user = await requireUser();
  const actor = await prisma.householdMember.findFirst({
    where: { householdId, userId: user.id, deletedAt: null, household: { deletedAt: null } }
  });
  if (!actor || actor.role !== HouseholdRole.owner) throw new Error("forbidden");

  const members = await prisma.householdMember.findMany({
    where: { householdId, deletedAt: null },
    include: { user: { select: { id: true, email: true, emailVerified: true } } },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }]
  });

  return members.filter(eligibleRecipient).map((member) => ({
    memberId: member.id,
    displayName: member.displayName,
    email: member.user?.email ?? null,
    role: member.role
  }));
}

/**
 * What the ownership-transfer screen needs to render, for whoever is looking at it.
 *
 * Both sides of a transfer use this: the owner sees who they could hand the household to and
 * whether an offer is already outstanding; the named recipient sees the offer waiting for them.
 * A member who is neither sees nothing to do.
 */
export async function getOwnershipTransferView(householdId: string) {
  const user = await requireUser();
  const actor = await prisma.householdMember.findFirst({
    where: { householdId, userId: user.id, deletedAt: null, household: { deletedAt: null } },
    include: { household: { select: { id: true, name: true } } }
  });
  if (!actor) throw new Error("forbidden");

  const transfer = await prisma.householdOwnershipTransfer.findFirst({
    where: { householdId, status: null },
    include: {
      fromMember: { select: { id: true, displayName: true } },
      toMember: { select: { id: true, displayName: true } }
    }
  });

  const isOwner = actor.role === HouseholdRole.owner;
  return {
    householdId,
    householdName: actor.household.name,
    isOwner,
    // Only the owner needs the list of who could take the household.
    recipients: isOwner ? await getOwnershipTransferRecipients(householdId) : [],
    pending: transfer
      ? {
          transferId: transfer.id,
          householdId,
          offeredBy: transfer.fromMember?.displayName ?? null,
          recipientName: transfer.toMember?.displayName ?? null,
          expiresAt: transfer.expiresAt.toISOString(),
          // Whether THIS person is the one being asked.
          awaitingMe: transfer.toMemberId === actor.id
        }
      : null
  };
}

/**
 * The owner names a successor. Nothing moves here -- this writes the pending row and returns.
 *
 * The household name must be typed exactly, matching how leaving a household already asks people to
 * confirm. It is the name the owner is looking at, and typing it is hard to do by accident.
 */
export async function initiateOwnershipTransfer(raw: unknown) {
  const input = initiateSchema.parse(raw);
  const freshSession = await requireFreshSession();
  const createdAt = new Date();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
    await lockAndRevalidateFreshSession(tx, freshSession);

    const actor = await tx.householdMember.findFirst({
      where: {
        householdId: input.householdId,
        userId: freshSession.user.id,
        deletedAt: null,
        household: { deletedAt: null }
      },
      include: { household: { select: { id: true, name: true } } }
    });
    if (!actor || actor.role !== HouseholdRole.owner) throw new Error("forbidden");

    if (input.confirmation !== actor.household.name) {
      throw new Error("household_ownership_transfer_confirmation_mismatch");
    }

    const recipient = await tx.householdMember.findFirst({
      where: { householdId: input.householdId, id: input.toMemberId, deletedAt: null },
      include: { user: { select: { id: true, email: true, emailVerified: true } } }
    });
    if (!recipient || !eligibleRecipient(recipient) || recipient.id === actor.id) {
      throw new Error("household_ownership_transfer_recipient_invalid");
    }

    // The database also enforces one pending transfer per household through a partial unique index;
    // this check exists to report the situation rather than surface a constraint violation.
    const outstanding = await tx.householdOwnershipTransfer.findFirst({
      where: { householdId: input.householdId, status: null }
    });
    if (outstanding) throw new Error("household_ownership_transfer_already_pending");

    const transfer = await tx.householdOwnershipTransfer.create({
      data: {
        householdId: input.householdId,
        fromMemberId: actor.id,
        toMemberId: recipient.id,
        status: null,
        expiresAt: new Date(createdAt.getTime() + HOUSEHOLD_OWNERSHIP_TRANSFER_TTL_MS),
        initiateOperationId: input.operationId
      }
    });

    await writeAudit(
      { userId: freshSession.user.id, householdId: input.householdId, memberId: actor.id, role: actor.role },
      {
        action: "household.ownership_transfer_initiated",
        entityType: "household_ownership_transfer",
        entityId: transfer.id,
        after: { fromMemberId: actor.id, toMemberId: recipient.id, expiresAt: transfer.expiresAt }
      },
      tx
    );

    return {
      transferId: transfer.id,
      householdId: input.householdId,
      fromMemberId: actor.id,
      toMemberId: recipient.id,
      expiresAt: transfer.expiresAt,
      status: "pending" as const
    };
  });
}

/** Shared by accept and decline: find the pending transfer and prove the caller is its recipient. */
async function loadSettleableTransfer(
  tx: Prisma.TransactionClient,
  input: z.infer<typeof settleSchema>,
  actorUserId: string
) {
  const actor = await tx.householdMember.findFirst({
    where: {
      householdId: input.householdId,
      userId: actorUserId,
      deletedAt: null,
      household: { deletedAt: null }
    }
  });
  if (!actor) throw new Error("forbidden");

  const transfer = await tx.householdOwnershipTransfer.findFirst({
    where: { id: input.transferId, householdId: input.householdId, status: null }
  });
  if (!transfer) throw new Error("not_found");
  // Only the named recipient may answer. Nobody else's acceptance means anything.
  if (transfer.toMemberId !== actor.id) throw new Error("forbidden");

  return { actor, transfer };
}

/**
 * The recipient accepts, and ownership moves atomically: one owner before, one owner after.
 *
 * Both role writes happen in the same transaction as the settlement, so there is no instant where
 * the household has two owners or none.
 */
export async function acceptOwnershipTransfer(raw: unknown) {
  const input = settleSchema.parse(raw);
  const freshSession = await requireFreshSession();
  const settledAt = new Date();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
    await lockAndRevalidateFreshSession(tx, freshSession);

    const { actor, transfer } = await loadSettleableTransfer(tx, input, freshSession.user.id);
    if (transfer.expiresAt <= settledAt) {
      throw new Error("household_ownership_transfer_expired");
    }

    const formerOwner = await tx.householdMember.findFirst({
      where: { householdId: input.householdId, id: transfer.fromMemberId, deletedAt: null }
    });
    // The owner who started this may have left or been removed meanwhile. Failing closed is the
    // only safe answer: promoting the recipient anyway would be acting on a stale intent.
    if (!formerOwner || formerOwner.role !== HouseholdRole.owner) {
      throw new Error("household_ownership_transfer_owner_changed");
    }

    // DEC-PROD-018: the former owner becomes an administrator, not a removed member.
    await tx.householdMember.update({
      where: { id: formerOwner.id },
      data: { role: HouseholdRole.admin }
    });
    await tx.householdMember.update({
      where: { id: actor.id },
      data: { role: HouseholdRole.owner }
    });
    await tx.householdOwnershipTransfer.update({
      where: { id: transfer.id },
      data: { status: "accepted", settledAt, settleOperationId: input.operationId }
    });

    await writeAudit(
      { userId: freshSession.user.id, householdId: input.householdId, memberId: actor.id, role: actor.role },
      {
        action: "household.ownership_transfer_accepted",
        entityType: "household_ownership_transfer",
        entityId: transfer.id,
        before: { ownerMemberId: formerOwner.id, recipientRole: actor.role },
        after: { ownerMemberId: actor.id, formerOwnerRole: HouseholdRole.admin, settledAt }
      },
      tx
    );

    return {
      transferId: transfer.id,
      householdId: input.householdId,
      ownerMemberId: actor.id,
      formerOwnerMemberId: formerOwner.id,
      settledAt,
      status: "accepted" as const
    };
  });
}

/**
 * The recipient declines. This settles the transfer and changes nobody's authority -- declining is
 * not a mutation of the household, it is the absence of one.
 */
export async function declineOwnershipTransfer(raw: unknown) {
  const input = settleSchema.parse(raw);
  const freshSession = await requireFreshSession();
  const settledAt = new Date();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
    await lockAndRevalidateFreshSession(tx, freshSession);

    const { actor, transfer } = await loadSettleableTransfer(tx, input, freshSession.user.id);

    await tx.householdOwnershipTransfer.update({
      where: { id: transfer.id },
      data: { status: "declined", settledAt, settleOperationId: input.operationId }
    });

    await writeAudit(
      { userId: freshSession.user.id, householdId: input.householdId, memberId: actor.id, role: actor.role },
      {
        action: "household.ownership_transfer_declined",
        entityType: "household_ownership_transfer",
        entityId: transfer.id,
        before: { toMemberId: transfer.toMemberId },
        after: { status: "declined", settledAt }
      },
      tx
    );

    return {
      transferId: transfer.id,
      householdId: input.householdId,
      settledAt,
      status: "declined" as const
    };
  });
}
