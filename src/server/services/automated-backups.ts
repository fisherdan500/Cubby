import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import type { AutomatedBackupConfig } from "@/lib/automated-backup-config";
import { automatedBackupConfig } from "@/lib/env";
import { buildHouseholdV2Snapshot, summarizeBackupItemCount } from "@/server/services/backups";
import {
  publishLocalBackup,
  readLocalBackup,
  reconcileLocalBackupTemps,
  removeLocalBackup,
  scanLocalBackups
} from "@/server/services/local-backup-storage";

const LOCK_NAMESPACE = 210715;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
type AutomationDb = Pick<
  Prisma.TransactionClient,
  "household" | "backupRecord" | "baby" | "contact" | "medicineCatalog" | "activityLog" | "calendarEvent" | "reminder"
>;

type BackupRecordRow = {
  id: string;
  createdAt: Date;
  checksum: string | null;
  status: string;
  error: string | null;
};

export function sanitizeAutomatedBackupError(error: unknown) {
  const allowed = new Set([
    "backup_active_timer",
    "backup_already_exists",
    "backup_directory_unavailable",
    "backup_invalid",
    "backup_retention_failed",
    "backup_too_large",
    "backup_write_failed"
  ]);
  if (error instanceof Error && allowed.has(error.message)) return error.message;
  return "backup_write_failed";
}

function nextRetryCutoff(now: Date, minutes: number) {
  return new Date(now.getTime() - minutes * MINUTE_MS);
}

function dueCutoff(now: Date, hours: number) {
  return new Date(now.getTime() - hours * HOUR_MS);
}

async function householdHasRecoverableData(tx: AutomationDb, householdId: string) {
  const [babies, contacts, catalogs, activities, events, reminders] = await Promise.all([
    tx.baby.count({ where: { householdId, deletedAt: null } }),
    tx.contact.count({ where: { householdId, deletedAt: null } }),
    tx.medicineCatalog.count({ where: { householdId, deletedAt: null } }),
    tx.activityLog.count({ where: { householdId, deletedAt: null } }),
    tx.calendarEvent.count({ where: { householdId, deletedAt: null } }),
    tx.reminder.count({ where: { householdId, deletedAt: null } })
  ]);
  return babies + contacts + catalogs + activities + events + reminders > 0;
}

async function latestAutomatedRecords(tx: AutomationDb, householdId: string) {
  const rows = await tx.backupRecord.findMany({
    where: { householdId, kind: "automated_export" },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, createdAt: true, checksum: true, status: true, error: true }
  });
  const latestSuccess = rows.find((row) => row.status === "complete") ?? null;
  const latestFailure = rows.find((row) => row.status === "failed") ?? null;
  return { latestSuccess, latestFailure };
}

function isBackupDue(records: { latestSuccess: BackupRecordRow | null; latestFailure: BackupRecordRow | null }, config: AutomatedBackupConfig, now: Date) {
  if (
    records.latestFailure &&
    (!records.latestSuccess || records.latestFailure.createdAt > records.latestSuccess.createdAt)
  ) {
    return records.latestFailure.createdAt <= nextRetryCutoff(now, config.retryMinutes);
  }
  if (!records.latestSuccess) return true;
  return records.latestSuccess.createdAt <= dueCutoff(now, config.intervalHours);
}

export async function pruneAutomatedBackups(config: AutomatedBackupConfig, householdId: string) {
  const records = await prisma.backupRecord.findMany({
    where: {
      householdId,
      kind: "automated_export",
      status: "complete",
      checksum: { not: null },
      storageFilename: { not: null }
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, checksum: true, storageFilename: true }
  });

  const associated: Array<{
    file: Awaited<ReturnType<typeof readLocalBackup>>;
    record: (typeof records)[number];
  }> = [];
  for (const record of records) {
    if (!record.storageFilename) continue;
    try {
      const file = await readLocalBackup(config.directory, record.storageFilename);
      if (file.checksum === record.checksum) associated.push({ file, record });
    } catch {
      // Retention never deletes an unavailable, invalid, or checksum-mismatched file.
    }
  }

  if (associated.length <= config.retentionCount) return;

  const toPrune = associated
    .sort((a, b) => a.file.exportedAt.localeCompare(b.file.exportedAt))
    .slice(0, associated.length - config.retentionCount);

  for (const entry of toPrune) {
    await removeLocalBackup(config.directory, entry.file.filename);
    await prisma.backupRecord.update({
      where: { id: entry.record.id },
      data: { status: "pruned" }
    });
  }
}

export async function reconcileAutomatedBackupStorage(config: AutomatedBackupConfig = automatedBackupConfig) {
  await reconcileLocalBackupTemps(config.directory);
  const [scanned, records] = await Promise.all([
    scanLocalBackups(config.directory),
    prisma.backupRecord.findMany({
      where: {
        kind: "automated_export",
        status: "complete",
        storageFilename: { not: null }
      },
      select: { id: true, checksum: true, storageFilename: true }
    })
  ]);

  for (const record of records) {
    let file = scanned.find((candidate) => candidate.filename === record.storageFilename);
    if (!file && record.storageFilename) {
      try {
        file = { healthy: true, ...(await readLocalBackup(config.directory, record.storageFilename)) };
      } catch {
        // The exact linked file is genuinely unavailable or invalid.
      }
    }
    const error = !file
      ? "backup_file_missing"
      : !file.healthy
        ? file.errorCode
        : file.checksum !== record.checksum
          ? "backup_checksum_mismatch"
          : null;
    if (!error) continue;
    await prisma.backupRecord.update({
      where: { id: record.id },
      data: { status: "failed", error }
    });
  }
}

export async function runAutomatedBackupIfDue(
  householdId: string,
  now = new Date(),
  config: AutomatedBackupConfig = automatedBackupConfig,
  dependencies: { publish?: typeof publishLocalBackup } = {}
) {
  if (!config.enabled) return { skipped: "disabled" as const };

  const records = await latestAutomatedRecords(prisma, householdId);
  if (!isBackupDue(records, config, now)) return { skipped: "not_due" as const };
  if (!(await householdHasRecoverableData(prisma, householdId))) return { skipped: "empty" as const };

  const publication: {
    file:
      | {
        filename: string;
        checksum: string;
        itemCount: number;
      }
      | null;
  } = { file: null };

  const outcome = await (async () => {
    try {
      return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const lockRows = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(${LOCK_NAMESPACE}::integer, hashtext(${householdId})) AS locked
        `;
      if (!lockRows[0]?.locked) return { skipped: "locked" as const };

      const lockedRecords = await latestAutomatedRecords(tx, householdId);
      if (!isBackupDue(lockedRecords, config, now)) return { skipped: "not_due" as const };
      if (!(await householdHasRecoverableData(tx, householdId))) return { skipped: "empty" as const };

      const snapshot = await buildHouseholdV2Snapshot(tx, householdId, now.toISOString());
      const filenameDiscriminator = createHash("sha256").update(householdId).digest("hex").slice(0, 32);
      const file = await (dependencies.publish ?? publishLocalBackup)(
        config.directory,
        JSON.stringify(snapshot, null, 2),
        { filenameDiscriminator }
      );
      const itemCount = summarizeBackupItemCount(snapshot);
      publication.file = { filename: file.filename, checksum: file.checksum, itemCount };

      await tx.backupRecord.create({
        data: {
          householdId,
          actorUserId: null,
          kind: "automated_export",
          status: "complete",
          itemCount,
          checksum: file.checksum,
          storageFilename: file.filename,
          byteSize: file.size
        }
      });

      return { completed: true as const };
      }, { isolationLevel: "RepeatableRead" });
    } catch (error) {
      if (publication.file?.filename) {
        await removeLocalBackup(config.directory, publication.file.filename).catch(() => undefined);
      }
      await prisma.backupRecord.create({
        data: {
          householdId,
          actorUserId: null,
          kind: "automated_export",
          status: "failed",
          error: sanitizeAutomatedBackupError(error)
        }
      }).catch(() => undefined);
      return { failed: true as const, error: sanitizeAutomatedBackupError(error) };
    }
  })();

  if ("completed" in outcome) {
    try {
      await pruneAutomatedBackups(config, householdId);
    } catch (error) {
      await prisma.backupRecord.create({
        data: {
          householdId,
          actorUserId: null,
          kind: "automated_export",
          status: "failed",
          error: "backup_retention_failed"
        }
      }).catch(() => undefined);
      console.error("backup_retention_failed", "backup_retention_failed");
    }
    return { completed: true as const, filename: publication.file?.filename ?? null };
  }
  return outcome;
}

export async function runAutomatedBackupScan(now = new Date(), config: AutomatedBackupConfig = automatedBackupConfig) {
  if (!config.enabled) return { skipped: "disabled" as const };

  const households = await prisma.household.findMany({
    where: { deletedAt: null },
    select: { id: true }
  });

  for (const household of households) {
    try {
      await runAutomatedBackupIfDue(household.id, now, config);
    } catch (error) {
      console.error("backup_household_scan_failed", sanitizeAutomatedBackupError(error));
    }
  }

  return { scanned: households.length };
}
