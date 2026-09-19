import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { writePlatformAudit } from "@/server/services/audit";
import {
  PLATFORM_SIGNUP_POLICY_LOCK_ID,
  PLATFORM_SINGLETON_ID
} from "@/server/services/platform-constants";

const explicitUserSchema = z.object({
  userId: z.string().trim().min(1),
  confirmEmail: z.string().min(1)
});

export const BOOTSTRAP_VERIFICATION_ACKNOWLEDGEMENT =
  "I_ACCEPT_LOCAL_BOOTSTRAP_EMAIL_VERIFICATION";

export const SUCCESSOR_VERIFICATION_ACKNOWLEDGEMENT =
  "I_ACCEPT_LOCAL_SUCCESSOR_EMAIL_VERIFICATION";

const bootstrapVerificationSchema = explicitUserSchema.extend({
  acknowledgement: z.string().min(1)
});

const recoverySchema = z.object({
  currentOwnerUserId: z.string().trim().min(1),
  successorUserId: z.string().trim().min(1),
  confirmSuccessorEmail: z.string().min(1)
});

const successorAttestationSchema = recoverySchema.extend({
  confirmSuccessorEmail: z.string().min(1),
  acknowledgement: z.string().min(1)
});

type BindingTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function requireExplicitCredentialUser(
  tx: BindingTransaction,
  userId: string,
  confirmEmail: string
) {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailVerified: true }
  });
  if (!user) throw new Error("platform_owner_user_not_found");
  if (user.email !== confirmEmail) {
    throw new Error("platform_owner_email_confirmation_mismatch");
  }
  const credential = await tx.account.findFirst({
    where: {
      userId: user.id,
      providerId: "credential",
      password: { not: null }
    },
    select: { id: true }
  });
  if (!credential) throw new Error("platform_owner_credential_missing");
  return user;
}

async function requireExplicitVerifiedUser(
  tx: BindingTransaction,
  userId: string,
  confirmEmail: string
) {
  const user = await requireExplicitCredentialUser(tx, userId, confirmEmail);
  if (!user.emailVerified) throw new Error("platform_owner_email_not_verified");
  return user;
}

const HOST_VERIFICATION_ERROR_CODES = [
  "platform_owner_already_bound",
  "platform_owner_bootstrap_user_count_mismatch",
  "platform_owner_not_bound",
  "platform_owner_current_confirmation_mismatch",
  "platform_owner_successor_must_differ",
  "platform_owner_user_not_found",
  "platform_owner_email_confirmation_mismatch",
  "platform_owner_credential_missing",
  "platform_owner_email_already_verified"
] as const;

/**
 * The verified flag is guarded in the database: guard_user_email_change() rejects any change made
 * directly by an application role, so a plain UPDATE here failed with
 * user_email_direct_mutation_forbidden and bootstrap could never complete. The write goes through
 * platform_host_verify_user_email, which re-checks the same preconditions under the same platform lock.
 * A null current owner selects bootstrap; a named one selects successor attestation.
 */
async function verifyUserEmailOnHost(
  tx: BindingTransaction,
  userId: string,
  confirmEmail: string,
  currentOwnerUserId: string | null
) {
  const [verified] = await tx.$queryRaw<Array<{ id: string; emailVerified: boolean }>>`
    SELECT "id", "emailVerified"
    FROM public."platform_host_verify_user_email"(${userId}, ${confirmEmail}, ${currentOwnerUserId}::TEXT)
  `;
  if (!verified?.emailVerified) throw new Error("platform_owner_operation_failed");
  return { id: verified.id, emailVerified: true };
}

function translateTransactionError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
    return new Error("platform_owner_operation_retry");
  }
  // A database-side precondition failure carries the same code the service checks raise.
  const message = error instanceof Error ? error.message : "";
  const code = HOST_VERIFICATION_ERROR_CODES.find((candidate) => message.includes(candidate));
  return code ? new Error(code) : error;
}

export async function verifyBootstrapPlatformOwnerCandidate(raw: unknown) {
  const input = bootstrapVerificationSchema.parse(raw);
  if (input.acknowledgement !== BOOTSTRAP_VERIFICATION_ACKNOWLEDGEMENT) {
    throw new Error("platform_owner_bootstrap_acknowledgement_required");
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
        const existing = await tx.platformAuthority.findUnique({
          where: { id: PLATFORM_SINGLETON_ID },
          select: { id: true, ownerUserId: true }
        });
        if (existing) throw new Error("platform_owner_already_bound");

        const userCount = await tx.user.count();
        if (userCount !== 1) throw new Error("platform_owner_bootstrap_user_count_mismatch");

        const user = await requireExplicitCredentialUser(tx, input.userId, input.confirmEmail);
        if (user.emailVerified) throw new Error("platform_owner_email_already_verified");

        const verified = await verifyUserEmailOnHost(tx, user.id, input.confirmEmail, null);
        await writePlatformAudit({
          action: "platform.owner.bootstrap_user.verify",
          entityType: "user",
          entityId: user.id,
          source: "host_local_bootstrap_verification"
        }, tx);
        return verified;
      },
      { isolationLevel: "Serializable" }
    );
  } catch (error) {
    throw translateTransactionError(error);
  }
}

export async function attestPlatformOwnerSuccessor(raw: unknown) {
  const input = successorAttestationSchema.parse(raw);
  if (input.acknowledgement !== SUCCESSOR_VERIFICATION_ACKNOWLEDGEMENT) {
    throw new Error("platform_owner_successor_acknowledgement_required");
  }
  if (input.currentOwnerUserId === input.successorUserId) {
    throw new Error("platform_owner_successor_must_differ");
  }
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "PlatformAuthority"
          WHERE "id" = ${PLATFORM_SINGLETON_ID}
          FOR UPDATE
        `;

        const authority = await tx.platformAuthority.findUnique({
          where: { id: PLATFORM_SINGLETON_ID },
          select: { id: true, ownerUserId: true }
        });
        if (!authority) throw new Error("platform_owner_not_bound");
        if (authority.ownerUserId !== input.currentOwnerUserId) {
          throw new Error("platform_owner_current_confirmation_mismatch");
        }

        const successor = await requireExplicitCredentialUser(
          tx,
          input.successorUserId,
          input.confirmSuccessorEmail
        );
        if (successor.email !== input.confirmSuccessorEmail) {
          throw new Error("platform_owner_email_confirmation_mismatch");
        }
        if (successor.emailVerified) throw new Error("platform_owner_email_already_verified");
        const verified = await verifyUserEmailOnHost(
          tx,
          successor.id,
          input.confirmSuccessorEmail,
          input.currentOwnerUserId
        );
        await writePlatformAudit({
          action: "platform.owner.successor_user.verify",
          entityType: "user",
          entityId: successor.id,
          source: "host_local_successor_verification"
        }, tx);
        return verified;
      },
      { isolationLevel: "Serializable" }
    );
  } catch (error) {
    throw translateTransactionError(error);
  }
}

export async function bindInitialPlatformOwner(raw: unknown) {
  const input = explicitUserSchema.parse(raw);
  try {
    return await prisma.$transaction(
      async (tx) => {
        const existing = await tx.platformAuthority.findUnique({
          where: { id: PLATFORM_SINGLETON_ID },
          select: { id: true, ownerUserId: true }
        });
        if (existing) throw new Error("platform_owner_already_bound");

        const user = await requireExplicitVerifiedUser(tx, input.userId, input.confirmEmail);
        const authority = await tx.platformAuthority.create({
          data: {
            id: PLATFORM_SINGLETON_ID,
            ownerUserId: user.id,
            settings: {
              create: {
                householdCreationMode: "closed",
                allowPublicRegistration: false
              }
            }
          },
          select: { id: true, ownerUserId: true }
        });
        await writePlatformAudit({
          action: "platform.owner.bootstrap",
          entityType: "platform_authority",
          entityId: PLATFORM_SINGLETON_ID,
          source: "host_local"
        }, tx);
        return authority;
      },
      { isolationLevel: "Serializable" }
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new Error("platform_owner_already_bound");
    }
    throw translateTransactionError(error);
  }
}

export async function recoverPlatformOwner(raw: unknown) {
  const input = recoverySchema.parse(raw);
  if (input.currentOwnerUserId === input.successorUserId) {
    throw new Error("platform_owner_successor_must_differ");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_SIGNUP_POLICY_LOCK_ID})`;
        const authority = await tx.platformAuthority.findUnique({
          where: { id: PLATFORM_SINGLETON_ID },
          select: { id: true, ownerUserId: true }
        });
        if (!authority) throw new Error("platform_owner_not_bound");
        if (authority.ownerUserId !== input.currentOwnerUserId) {
          throw new Error("platform_owner_current_confirmation_mismatch");
        }

        const successor = await requireExplicitVerifiedUser(
          tx,
          input.successorUserId,
          input.confirmSuccessorEmail
        );
        const changed = await tx.platformAuthority.updateMany({
          where: {
            id: PLATFORM_SINGLETON_ID,
            ownerUserId: input.currentOwnerUserId
          },
          data: { ownerUserId: successor.id }
        });
        if (changed.count !== 1) throw new Error("platform_owner_changed");

        await writePlatformAudit({
          action: "platform.owner.recover",
          entityType: "platform_authority",
          entityId: PLATFORM_SINGLETON_ID,
          source: "host_local_recovery"
        }, tx);
        return { id: PLATFORM_SINGLETON_ID, ownerUserId: successor.id };
      },
      { isolationLevel: "Serializable", maxWait: 10_000, timeout: 20_000 }
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt === 0) continue;
      throw translateTransactionError(error);
    }
  }
  throw new Error("platform_owner_operation_retry");
}
