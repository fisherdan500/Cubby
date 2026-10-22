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
 *
 * Two things in here are deliberately paranoid, because an ownership mutation that half-happens
 * leaves a household nobody can administer:
 *
 * Every path that moves or blocks ownership locks the member rows it is about to judge, with
 * `FOR UPDATE` in a fixed id order, exactly as `removeMember` and `updateMemberRole` do. The
 * advisory lock alone is not enough: those two take row locks and NO advisory lock, so a
 * transfer holding only the advisory lock shares no mutual exclusion with them at all. Without
 * the row locks, a member removal committing between this transaction's read and its write
 * promotes a soft-deleted member to owner and leaves the household with zero active owners --
 * and `owner` is absent from `assignableHouseholdRoles`, so that state can never be repaired.
 *
 * Eligibility is re-checked at acceptance, not just at initiation. Several days can pass in
 * between, and a suspension that lands in the window must not be undone by the acceptance: a
 * suspended owner can neither act nor be demoted, which is another unrepairable household.
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

const cancelSchema = z.object({
  householdId: z.string().min(1),
  transferId: z.string().min(1),
  operationId: z.string().uuid()
}).strict();

/**
 * The database's own clock, read inside the transaction.
 *
 * A transaction can sit in the advisory-lock queue for a long time, so a timestamp taken before
 * the lock was acquired is not the time at which this decision is being made. Expiry is a
 * deadline, so it has to be judged against the clock at the moment of judgement.
 */
async function transactionNow(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  return rows[0].now;
}

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

/**
 * Take row locks on the members this transaction is about to read and write.
 *
 * Sorted by id so that two transfers, or a transfer and a member removal, can never hold each
 * other's next lock. `removeMember` locks in the same `ORDER BY "id"` order for the same reason.
 */
async function lockMembersForOwnershipMutation(tx: Prisma.TransactionClient, memberIds: string[]) {
  const ids = [...new Set(memberIds)].sort();
  if (ids.length === 0) return;
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "HouseholdMember"
    WHERE "id" IN (${Prisma.join(ids)})
    ORDER BY "id"
    FOR UPDATE
  `;
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

  return listOwnershipTransferRecipients(prisma, householdId);
}

/** The eligible-recipient query itself, once the caller's authority is already established. */
async function listOwnershipTransferRecipients(
  client: Prisma.TransactionClient | typeof prisma,
  householdId: string
) {
  const members = await client.householdMember.findMany({
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
 * A member who is neither sees nothing to do -- and is told nothing about the offer, because who
 * was asked to take the household is not information a bystander needs.
 */
export async function getOwnershipTransferView(householdId: string) {
  const user = await requireUser();
  // A suspended member can neither offer a household nor accept one, so showing them an offer
  // would be showing them a button that always refuses. Every mutating path filters disabledAt;
  // the reader has to agree with them or the screen promises something the service denies.
  const actor = await prisma.householdMember.findFirst({
    where: {
      householdId,
      userId: user.id,
      deletedAt: null,
      disabledAt: null,
      household: { deletedAt: null }
    },
    include: { household: { select: { id: true, name: true } } }
  });
  if (!actor) throw new Error("forbidden");

  // An expired offer is not a live offer: it must not be rendered as something answerable, and it
  // must not be reported to the owner as an obstacle, because initiating again now clears it.
  const transfer = await prisma.householdOwnershipTransfer.findFirst({
    where: { householdId, status: null, expiresAt: { gt: new Date() } },
    include: {
      fromMember: { select: { id: true, displayName: true } },
      toMember: { select: { id: true, displayName: true } }
    }
  });

  const isOwner = actor.role === HouseholdRole.owner;
  const awaitingMe = transfer ? transfer.toMemberId === actor.id : false;
  const visible = transfer !== null && (isOwner || awaitingMe);

  return {
    householdId,
    householdName: actor.household.name,
    isOwner,
    // Only the owner needs the list of who could take the household.
    recipients: isOwner ? await listOwnershipTransferRecipients(prisma, householdId) : [],
    pending: visible && transfer
      ? {
          transferId: transfer.id,
          householdId,
          offeredBy: transfer.fromMember?.displayName ?? null,
          recipientName: transfer.toMember?.displayName ?? null,
          expiresAt: transfer.expiresAt.toISOString(),
          // Whether THIS person is the one being asked.
          awaitingMe
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

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
    await lockAndRevalidateFreshSession(tx, freshSession);
    const now = await transactionNow(tx);

    // A retried request must not become a second offer. The operation id is unique in the
    // database, so without this the retry surfaces a constraint violation as a 500.
    const completedOperation = await tx.householdOwnershipTransfer.findFirst({
      where: { initiateOperationId: input.operationId }
    });
    if (completedOperation) {
      if (completedOperation.householdId !== input.householdId) throw new Error("forbidden");
      if (completedOperation.status === null) {
        return {
          transferId: completedOperation.id,
          householdId: input.householdId,
          fromMemberId: completedOperation.fromMemberId,
          toMemberId: completedOperation.toMemberId,
          expiresAt: completedOperation.expiresAt,
          status: "pending" as const
        };
      }
      throw new Error("household_ownership_transfer_operation_reused");
    }

    await lockMembersForOwnershipMutation(tx, [input.toMemberId]);

    const actor = await tx.householdMember.findFirst({
      where: {
        householdId: input.householdId,
        userId: freshSession.user.id,
        deletedAt: null,
        disabledAt: null,
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
    if (outstanding) {
      // An offer nobody answered within its window must not lock the household out of ever
      // transferring ownership again. Expiry is only meaningful if something acts on it, and the
      // owner starting a fresh offer is exactly that moment: settle the dead row and carry on.
      if (outstanding.expiresAt <= now) {
        await tx.householdOwnershipTransfer.update({
          where: { id: outstanding.id },
          data: { status: "expired", settledAt: now }
        });
      } else {
        throw new Error("household_ownership_transfer_already_pending");
      }
    }

    const transfer = await tx.householdOwnershipTransfer.create({
      data: {
        householdId: input.householdId,
        fromMemberId: actor.id,
        toMemberId: recipient.id,
        status: null,
        expiresAt: new Date(now.getTime() + HOUSEHOLD_OWNERSHIP_TRANSFER_TTL_MS),
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
  if (!transfer) {
    // The recipient may have had this page open while the owner withdrew the offer, or while
    // somebody answered it. "Not found" is true but tells them nothing, so look at why the row is
    // no longer pending and say that instead.
    const settled = await tx.householdOwnershipTransfer.findFirst({
      where: { id: input.transferId, householdId: input.householdId }
    });
    if (settled?.status === "cancelled") {
      throw new Error("household_ownership_transfer_withdrawn");
    }
    if (settled?.status === "expired") {
      throw new Error("household_ownership_transfer_expired");
    }
    if (settled) throw new Error("household_ownership_transfer_already_answered");
    throw new Error("not_found");
  }
  // Only the named recipient may answer. Nobody else's acceptance means anything.
  if (transfer.toMemberId !== actor.id) throw new Error("forbidden");

  return { actor, transfer };
}

/** A settle request replayed after it already succeeded must not be judged a second time. */
async function findSettledOperation(
  tx: Prisma.TransactionClient,
  input: z.infer<typeof settleSchema>
) {
  const settled = await tx.householdOwnershipTransfer.findFirst({
    where: { settleOperationId: input.operationId }
  });
  if (!settled) return null;
  if (settled.householdId !== input.householdId || settled.id !== input.transferId) {
    throw new Error("forbidden");
  }
  return settled;
}

/**
 * The recipient accepts, and ownership moves atomically: one owner before, one owner after.
 *
 * Both role writes happen in the same transaction as the settlement, under row locks on both
 * members, so there is no instant where the household has two owners or none -- and no concurrent
 * member removal can slip between the checks and the writes.
 */
export async function acceptOwnershipTransfer(raw: unknown) {
  const input = settleSchema.parse(raw);
  const freshSession = await requireFreshSession();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
    await lockAndRevalidateFreshSession(tx, freshSession);
    const now = await transactionNow(tx);

    const replayed = await findSettledOperation(tx, input);
    if (replayed) {
      if (replayed.status !== "accepted") throw new Error("household_ownership_transfer_operation_reused");
      return {
        transferId: replayed.id,
        householdId: input.householdId,
        ownerMemberId: replayed.toMemberId,
        formerOwnerMemberId: replayed.fromMemberId,
        settledAt: replayed.settledAt ?? now,
        status: "accepted" as const
      };
    }

    const { actor, transfer } = await loadSettleableTransfer(tx, input, freshSession.user.id);
    if (transfer.expiresAt <= now) {
      throw new Error("household_ownership_transfer_expired");
    }

    // Lock both members before judging either of them, so the state proved below is still true
    // when the writes land. `removeMember` and `updateMemberRole` contend on these same rows.
    await lockMembersForOwnershipMutation(tx, [transfer.fromMemberId, transfer.toMemberId]);

    const formerOwner = await tx.householdMember.findFirst({
      where: { householdId: input.householdId, id: transfer.fromMemberId, deletedAt: null }
    });
    // The owner who started this may have left or been removed meanwhile. Failing closed is the
    // only safe answer: promoting the recipient anyway would be acting on a stale intent.
    if (!formerOwner || formerOwner.role !== HouseholdRole.owner) {
      throw new Error("household_ownership_transfer_owner_changed");
    }

    // Re-read the recipient under the lock. Days can pass between offer and acceptance, and a
    // member removed or suspended in that window must not be promoted: a suspended owner can
    // neither act nor be demoted, and a soft-deleted owner leaves zero active owners.
    const recipient = await tx.householdMember.findFirst({
      where: { householdId: input.householdId, id: transfer.toMemberId, deletedAt: null },
      include: { user: { select: { id: true, email: true, emailVerified: true } } }
    });
    if (!recipient || recipient.id !== actor.id || !eligibleRecipient(recipient)) {
      // A distinct code from the initiate-side one: the person reading this is the recipient, who
      // is choosing nobody and can invite nobody, so "choose an active member" is not advice they
      // can act on.
      throw new Error("household_ownership_transfer_recipient_ineligible");
    }

    // DEC-PROD-018: the former owner becomes an administrator, not a removed member.
    await tx.householdMember.update({
      where: { id: formerOwner.id },
      data: { role: HouseholdRole.admin }
    });
    await tx.householdMember.update({
      where: { id: recipient.id },
      data: { role: HouseholdRole.owner }
    });
    await tx.householdOwnershipTransfer.update({
      where: { id: transfer.id },
      data: { status: "accepted", settledAt: now, settleOperationId: input.operationId }
    });

    await writeAudit(
      { userId: freshSession.user.id, householdId: input.householdId, memberId: actor.id, role: actor.role },
      {
        action: "household.ownership_transfer_accepted",
        entityType: "household_ownership_transfer",
        entityId: transfer.id,
        before: { ownerMemberId: formerOwner.id, recipientRole: actor.role },
        after: { ownerMemberId: actor.id, formerOwnerRole: HouseholdRole.admin, settledAt: now }
      },
      tx
    );

    return {
      transferId: transfer.id,
      householdId: input.householdId,
      ownerMemberId: actor.id,
      formerOwnerMemberId: formerOwner.id,
      settledAt: now,
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

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
    await lockAndRevalidateFreshSession(tx, freshSession);
    const now = await transactionNow(tx);

    const replayed = await findSettledOperation(tx, input);
    if (replayed) {
      if (replayed.status !== "declined") throw new Error("household_ownership_transfer_operation_reused");
      return {
        transferId: replayed.id,
        householdId: input.householdId,
        settledAt: replayed.settledAt ?? now,
        status: "declined" as const
      };
    }

    const { actor, transfer } = await loadSettleableTransfer(tx, input, freshSession.user.id);

    await tx.householdOwnershipTransfer.update({
      where: { id: transfer.id },
      data: { status: "declined", settledAt: now, settleOperationId: input.operationId }
    });

    await writeAudit(
      { userId: freshSession.user.id, householdId: input.householdId, memberId: actor.id, role: actor.role },
      {
        action: "household.ownership_transfer_declined",
        entityType: "household_ownership_transfer",
        entityId: transfer.id,
        before: { toMemberId: transfer.toMemberId },
        after: { status: "declined", settledAt: now }
      },
      tx
    );

    return {
      transferId: transfer.id,
      householdId: input.householdId,
      settledAt: now,
      status: "declined" as const
    };
  });
}

/**
 * The owner withdraws an offer nobody has answered.
 *
 * Without this the owner is stuck: one pending transfer is allowed per household, so an offer made
 * to the wrong person -- or to someone who simply never replies -- would block every future
 * transfer, and an owner cannot leave a household either. Withdrawing changes nobody's authority.
 */
export async function cancelOwnershipTransfer(raw: unknown) {
  const input = cancelSchema.parse(raw);
  const freshSession = await requireFreshSession();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
    await lockAndRevalidateFreshSession(tx, freshSession);
    const now = await transactionNow(tx);

    const replayed = await tx.householdOwnershipTransfer.findFirst({
      where: { settleOperationId: input.operationId }
    });
    if (replayed) {
      if (
        replayed.householdId !== input.householdId
        || replayed.id !== input.transferId
        || replayed.status !== "cancelled"
      ) {
        throw new Error("household_ownership_transfer_operation_reused");
      }
      return {
        transferId: replayed.id,
        householdId: input.householdId,
        settledAt: replayed.settledAt ?? now,
        status: "cancelled" as const
      };
    }

    const actor = await tx.householdMember.findFirst({
      where: {
        householdId: input.householdId,
        userId: freshSession.user.id,
        deletedAt: null,
        disabledAt: null,
        household: { deletedAt: null }
      }
    });
    if (!actor || actor.role !== HouseholdRole.owner) throw new Error("forbidden");

    const transfer = await tx.householdOwnershipTransfer.findFirst({
      where: { id: input.transferId, householdId: input.householdId, status: null }
    });
    if (!transfer) throw new Error("not_found");

    await tx.householdOwnershipTransfer.update({
      where: { id: transfer.id },
      data: { status: "cancelled", settledAt: now, settleOperationId: input.operationId }
    });

    await writeAudit(
      { userId: freshSession.user.id, householdId: input.householdId, memberId: actor.id, role: actor.role },
      {
        action: "household.ownership_transfer_cancelled",
        entityType: "household_ownership_transfer",
        entityId: transfer.id,
        before: { toMemberId: transfer.toMemberId, status: null },
        after: { status: "cancelled", settledAt: now }
      },
      tx
    );

    return {
      transferId: transfer.id,
      householdId: input.householdId,
      settledAt: now,
      status: "cancelled" as const
    };
  });
}
