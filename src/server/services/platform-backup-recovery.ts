import { HouseholdRole, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { automatedBackupConfig } from "@/lib/env";
import { PLATFORM_SINGLETON_ID } from "@/server/services/platform-constants";
import { isLocalBackupFilename, readLocalBackup } from "@/server/services/local-backup-storage";
import { lockHouseholdCreation } from "@/server/services/mutation-locks";

export const BACKUP_RECOVERY_ACKNOWLEDGEMENT =
  "I_AUTHORIZE_EXPLICIT_BACKUP_RECOVERY";
export const BACKUP_RECOVERY_TARGET_ACKNOWLEDGEMENT =
  "I_PROVISION_EMPTY_BACKUP_RECOVERY_TARGET";

const explicitFilenameSchema = z.string().min(1).max(255).refine(isLocalBackupFilename);

const inspectRecoveryCandidateSchema = z.object({
  currentOwnerUserId: z.string().trim().min(1),
  filename: explicitFilenameSchema
});

const authorizeRecoverySchema = inspectRecoveryCandidateSchema.extend({
  targetHouseholdId: z.string().trim().min(1),
  targetOwnerUserId: z.string().trim().min(1),
  confirmTargetOwnerEmail: z.string().min(1),
  confirmChecksum: z.string().min(1),
  confirmSourceHouseholdName: z.string().min(1),
  acknowledgement: z.string().min(1)
});

const provisionRecoveryTargetSchema = z.object({
  currentOwnerUserId: z.string().trim().min(1),
  targetOwnerUserId: z.string().trim().min(1),
  confirmTargetOwnerEmail: z.string().min(1),
  targetHouseholdName: z.string().trim().min(1).max(100),
  acknowledgement: z.string().min(1)
});

type RecoveryTransaction = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type FreshTargetState = {
  actorIsSoleOwner: boolean;
  operationalCount: bigint | number;
};

function translateRecoveryTransactionError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") return new Error("backup_recovery_already_authorized");
    if (error.code === "P2034") return new Error("platform_owner_operation_retry");
  }
  return error;
}

function requireConfirmedCandidate(
  candidate: { checksum: string; householdName: string },
  confirmation: { confirmChecksum: string; confirmSourceHouseholdName: string }
) {
  if (candidate.checksum !== confirmation.confirmChecksum) {
    throw new Error("backup_recovery_checksum_mismatch");
  }
  if (candidate.householdName !== confirmation.confirmSourceHouseholdName) {
    throw new Error("backup_recovery_source_confirmation_mismatch");
  }
}

async function requireCurrentPlatformOwner(
  db: Pick<RecoveryTransaction, "platformAuthority">,
  currentOwnerUserId: string
) {
  const authority = await db.platformAuthority.findUnique({
    where: { id: PLATFORM_SINGLETON_ID },
    select: { id: true, ownerUserId: true }
  });
  if (!authority) throw new Error("platform_owner_not_bound");
  if (authority.ownerUserId !== currentOwnerUserId) {
    throw new Error("platform_owner_current_confirmation_mismatch");
  }
  return authority;
}

async function requireClosedHouseholdCreationPolicy(tx: RecoveryTransaction) {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "PlatformSettings"
    WHERE "id" = ${PLATFORM_SINGLETON_ID}
    FOR UPDATE
  `;
  const settings = await tx.platformSettings.findUnique({
    where: { id: PLATFORM_SINGLETON_ID },
    select: { id: true, householdCreationMode: true, allowPublicRegistration: true }
  });
  if (
    !settings ||
    settings.householdCreationMode !== "closed" ||
    settings.allowPublicRegistration
  ) {
    throw new Error("backup_recovery_household_creation_not_closed");
  }
}

async function requireUnassociatedStorageFilename(
  db: Pick<RecoveryTransaction, "backupRecord">,
  storageFilename: string
) {
  const existing = await db.backupRecord.findUnique({
    where: { storageFilename },
    select: { id: true }
  });
  if (existing) throw new Error("backup_recovery_already_authorized");
}

async function requireFreshTarget(
  tx: RecoveryTransaction,
  targetHouseholdId: string,
  targetOwnerUserId: string
) {
  const activeHouseholdCount = await tx.household.count({ where: { deletedAt: null } });
  if (activeHouseholdCount !== 1) {
    throw new Error("backup_recovery_target_count_mismatch");
  }

  const target = await tx.household.findFirst({
    where: { id: targetHouseholdId, deletedAt: null },
    select: { id: true, name: true }
  });
  if (!target) throw new Error("backup_recovery_target_not_found");

  const rows = await tx.$queryRaw<FreshTargetState[]>`
    SELECT
      ((SELECT COUNT(*) FROM "HouseholdMember"
          WHERE "householdId" = ${targetHouseholdId}
            AND "deletedAt" IS NULL
            AND "disabledAt" IS NULL) = 1
       AND EXISTS (
         SELECT 1 FROM "HouseholdMember"
          WHERE "householdId" = ${targetHouseholdId}
            AND "userId" = ${targetOwnerUserId}
            AND role = 'owner'::"HouseholdRole"
            AND "deletedAt" IS NULL
            AND "disabledAt" IS NULL
       )) AS "actorIsSoleOwner",
      ((SELECT COUNT(*) FROM "Baby" WHERE "householdId" = ${targetHouseholdId}) +
       (SELECT COUNT(*) FROM "ActivityLog" WHERE "householdId" = ${targetHouseholdId}) +
       (SELECT COUNT(*) FROM "Contact" WHERE "householdId" = ${targetHouseholdId}) +
       (SELECT COUNT(*) FROM "MedicineCatalog" WHERE "householdId" = ${targetHouseholdId}) +
       (SELECT COUNT(*) FROM "CalendarEvent" WHERE "householdId" = ${targetHouseholdId}) +
       (SELECT COUNT(*) FROM "Reminder" WHERE "householdId" = ${targetHouseholdId}) +
       (SELECT COUNT(*) FROM "Invite" WHERE "householdId" = ${targetHouseholdId}) +
       (SELECT COUNT(*) FROM "ApiKey" WHERE "householdId" = ${targetHouseholdId}) +
       (SELECT COUNT(*) FROM "WebhookEndpoint" WHERE "householdId" = ${targetHouseholdId}) +
       (SELECT COUNT(*) FROM "WebhookDelivery" WHERE "householdId" = ${targetHouseholdId}) +
       (SELECT COUNT(*) FROM "PushSubscription" WHERE "householdId" = ${targetHouseholdId}) +
       (SELECT COUNT(*) FROM "NotificationPreference" WHERE "householdId" = ${targetHouseholdId}) +
       (SELECT COUNT(*) FROM "NotificationLog" WHERE "householdId" = ${targetHouseholdId})) AS "operationalCount"
  `;
  const state = rows[0];
  if (!state?.actorIsSoleOwner) {
    throw new Error("backup_recovery_target_owner_not_sole");
  }
  if (Number(state.operationalCount) !== 0) throw new Error("backup_target_not_empty");
  return target;
}

async function requireTargetOwnerCredential(
  tx: RecoveryTransaction,
  targetOwnerUserId: string,
  confirmTargetOwnerEmail: string
) {
  const user = await tx.user.findUnique({
    where: { id: targetOwnerUserId },
    select: { id: true, name: true, email: true }
  });
  if (!user) throw new Error("backup_recovery_target_owner_not_found");
  if (user.email !== confirmTargetOwnerEmail) {
    throw new Error("backup_recovery_target_owner_email_mismatch");
  }

  const credential = await tx.account.findFirst({
    where: {
      userId: user.id,
      providerId: "credential",
      password: { not: null }
    },
    select: { id: true }
  });
  if (!credential) throw new Error("backup_recovery_target_owner_credential_missing");
  return user;
}

export async function provisionBackupRecoveryTarget(raw: unknown) {
  const input = provisionRecoveryTargetSchema.parse(raw);
  if (input.acknowledgement !== BACKUP_RECOVERY_TARGET_ACKNOWLEDGEMENT) {
    throw new Error("backup_recovery_target_acknowledgement_required");
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        await lockHouseholdCreation(tx);
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "PlatformAuthority"
          WHERE "id" = ${PLATFORM_SINGLETON_ID}
          FOR UPDATE
        `;
        const authority = await requireCurrentPlatformOwner(tx, input.currentOwnerUserId);
        await requireClosedHouseholdCreationPolicy(tx);
        const activeHouseholdCount = await tx.household.count({ where: { deletedAt: null } });
        if (activeHouseholdCount !== 0) {
          throw new Error("backup_recovery_target_count_mismatch");
        }
        const targetOwner = await requireTargetOwnerCredential(
          tx,
          input.targetOwnerUserId,
          input.confirmTargetOwnerEmail
        );

        const target = await tx.household.create({
          data: {
            name: input.targetHouseholdName,
            createdByUserId: targetOwner.id,
            members: {
              create: {
                userId: targetOwner.id,
                role: HouseholdRole.owner,
                displayName: targetOwner.name ?? targetOwner.email
              }
            },
            settings: {
              create: {
                allowPublicRegistration: false,
                allowNewHouseholdCreation: false
              }
            }
          },
          select: { id: true }
        });
        const auditAfter = {
          confirmedPlatformOwnerUserId: authority.ownerUserId,
          targetHouseholdId: target.id,
          targetOwnerUserId: targetOwner.id
        };
        await tx.platformAuditEvent.create({
          data: {
            actorUserId: null,
            action: "platform.backup_recovery.target.provision",
            entityType: "household",
            entityId: target.id,
            source: "host_local_backup_recovery",
            after: auditAfter
          }
        });
        await tx.auditEvent.create({
          data: {
            householdId: target.id,
            actorUserId: null,
            actorMemberId: null,
            action: "backup.recovery.target.provision",
            entityType: "household",
            entityId: target.id,
            after: auditAfter
          }
        });
        return {
          targetHouseholdId: target.id,
          targetOwnerUserId: targetOwner.id
        };
      },
      {
        isolationLevel: "Serializable",
        maxWait: 5_000,
        timeout: 15_000
      }
    );
  } catch (error) {
    throw translateRecoveryTransactionError(error);
  }
}

export async function inspectBackupRecoveryCandidate(raw: unknown) {
  const input = inspectRecoveryCandidateSchema.parse(raw);
  await requireCurrentPlatformOwner(prisma, input.currentOwnerUserId);
  await requireUnassociatedStorageFilename(prisma, input.filename);

  const file = await readLocalBackup(automatedBackupConfig.directory, input.filename);
  return {
    filename: file.filename,
    exportedAt: file.exportedAt,
    householdName: file.householdName,
    checksum: file.checksum,
    size: file.size,
    itemCount: file.itemCount
  };
}

export async function authorizeBackupRecovery(raw: unknown) {
  const input = authorizeRecoverySchema.parse(raw);
  if (input.acknowledgement !== BACKUP_RECOVERY_ACKNOWLEDGEMENT) {
    throw new Error("backup_recovery_acknowledgement_required");
  }

  await requireCurrentPlatformOwner(prisma, input.currentOwnerUserId);
  await requireUnassociatedStorageFilename(prisma, input.filename);
  const file = await readLocalBackup(automatedBackupConfig.directory, input.filename);
  requireConfirmedCandidate(file, input);

  try {
    return await prisma.$transaction(
      async (tx) => {
        await lockHouseholdCreation(tx);
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "PlatformAuthority"
          WHERE "id" = ${PLATFORM_SINGLETON_ID}
          FOR UPDATE
        `;
        const authority = await requireCurrentPlatformOwner(tx, input.currentOwnerUserId);
        await requireClosedHouseholdCreationPolicy(tx);
        await requireFreshTarget(tx, input.targetHouseholdId, input.targetOwnerUserId);
        const targetOwner = await requireTargetOwnerCredential(
          tx,
          input.targetOwnerUserId,
          input.confirmTargetOwnerEmail
        );

        const candidate = await readLocalBackup(automatedBackupConfig.directory, input.filename);
        requireConfirmedCandidate(candidate, input);
        await requireUnassociatedStorageFilename(tx, candidate.filename);

        const record = await tx.backupRecord.create({
          data: {
            householdId: input.targetHouseholdId,
            actorUserId: null,
            kind: "recovery_authorized",
            status: "complete",
            checksum: candidate.checksum,
            itemCount: candidate.itemCount,
            storageFilename: candidate.filename,
            byteSize: candidate.size
          },
          select: { id: true }
        });
        const auditAfter = {
          confirmedPlatformOwnerUserId: authority.ownerUserId,
          targetHouseholdId: input.targetHouseholdId,
          targetOwnerUserId: targetOwner.id,
          storageFilename: candidate.filename,
          checksum: candidate.checksum,
          sourceHouseholdName: candidate.householdName
        };
        await tx.platformAuditEvent.create({
          data: {
            actorUserId: null,
            action: "platform.backup_recovery.authorize",
            entityType: "backup_record",
            entityId: record.id,
            source: "host_local_backup_recovery",
            after: auditAfter
          }
        });
        await tx.auditEvent.create({
          data: {
            householdId: input.targetHouseholdId,
            actorUserId: null,
            actorMemberId: null,
            action: "backup.recovery.authorize",
            entityType: "backup_record",
            entityId: record.id,
            after: auditAfter
          }
        });

        return {
          backupRecordId: record.id,
          targetHouseholdId: input.targetHouseholdId,
          targetOwnerUserId: targetOwner.id,
          filename: candidate.filename,
          checksum: candidate.checksum
        };
      },
      {
        isolationLevel: "Serializable",
        maxWait: 5_000,
        timeout: 15_000
      }
    );
  } catch (error) {
    throw translateRecoveryTransactionError(error);
  }
}
