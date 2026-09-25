import { TimerState, type Prisma } from "@prisma/client";
import { z } from "zod";
import { automatedBackupStatusConfig } from "@/lib/automated-backup-config";
import { prisma } from "@/lib/db/prisma";
import { automatedBackupConfig } from "@/lib/env";
import { activityBackupDetailKeys, activityDetailRecord } from "@/domain/activity-field-matrix";
import { parseAccentTheme } from "@/domain/appearance";
import { PLANNED_SCHEDULE_SCHEMA_VERSION, plannedScheduleDocumentSchema } from "@/domain/planned-schedule";
import { parseUnitPreferences } from "@/domain/unit-preferences";
import { activityRestoreSchema } from "@/lib/validation/activity";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { activityInclude, restoreHistoricalActivityForContext } from "@/server/services/activities";
import { writeAudit } from "@/server/services/audit";
import { readHouseholdAuditIntegrity } from "@/server/services/audit-checkpoints";
import { lockActorForWrite, lockBabyForWrite } from "@/server/services/mutation-locks";
import { backupSummary, createV2Backup, parseBackup, type ParsedBackup } from "@/server/services/backup-format";
import { newAttachmentStorageKey } from "@/domain/attachments";
import { attachmentConfig } from "@/lib/env";
import { readAttachmentObject, removeAttachmentObject, writeAttachmentObject } from "@/server/services/attachment-store";
import { backupArchiveStream, openBackupArchive } from "@/server/services/backup-archive";
import {
  isLocalBackupFilename,
  readLocalBackup,
  readLocalBackupDocument,
  scanLocalBackups
} from "@/server/services/local-backup-storage";

const backupDateTime = z.string().datetime({ offset: true });
const backupActivityInclude = {
  ...activityInclude,
  pauseIntervals: {
    select: { startedAt: true, endedAt: true },
    orderBy: { startedAt: "asc" as const }
  }
} satisfies Prisma.ActivityLogInclude;
const backupTimerMetadata = z
  .object({
    timerState: z.enum(["none", "running", "paused", "stopped"]).optional(),
    durationSeconds: z.number().int().nonnegative().nullable().optional(),
    pausedAt: backupDateTime.nullable().optional(),
    pausedSeconds: z.number().int().nonnegative().optional()
  })
  .passthrough();

const timerMetadataFields = ["timerState", "durationSeconds", "pausedAt", "pausedSeconds"] as const;
const timerCapableBackupTypes = new Set(["feeding", "sleep", "pumping", "play"]);

type BackupActivityInput = z.infer<typeof activityRestoreSchema>;
type BackupSnapshotTransaction = Pick<
  Prisma.TransactionClient,
  "household" | "householdSettings" | "baby" | "contact" | "medicineCatalog" | "activityLog" | "calendarEvent" | "reminder" | "plannedSchedule" | "feedPost"
  | "feedComment" | "feedReaction" | "attachment"
>;

function parseHistoricalTimerMetadata(rawActivity: Record<string, unknown>, activity: BackupActivityInput) {
  const metadata = backupTimerMetadata.parse(rawActivity);
  const presentFields = timerMetadataFields.filter((field) => Object.prototype.hasOwnProperty.call(rawActivity, field));

  if (activity.activeTimer || metadata.timerState === "running" || metadata.timerState === "paused") {
    throw new Error("backup_active_timer");
  }
  if (metadata.timerState === undefined) {
    if (presentFields.length) throw new Error("backup_invalid_timer");
    return undefined;
  }
  if (presentFields.length !== timerMetadataFields.length) throw new Error("backup_invalid_timer");

  const hasStartedAt = activity.startedAt !== undefined;
  const hasEndedAt = activity.endedAt !== undefined;
  const wallSeconds =
    hasStartedAt && hasEndedAt
      ? Math.max(0, Math.round((new Date(activity.endedAt!).getTime() - new Date(activity.startedAt!).getTime()) / 1000))
      : null;

  if (metadata.timerState === "none") {
    if (
      metadata.durationSeconds === undefined ||
      metadata.pausedAt !== null ||
      metadata.pausedSeconds !== 0 ||
      metadata.durationSeconds !== wallSeconds
    ) {
      throw new Error("backup_invalid_timer");
    }
    return undefined;
  }

  if (
    !timerCapableBackupTypes.has(activity.type) ||
    !hasStartedAt ||
    !hasEndedAt ||
    metadata.durationSeconds == null ||
    metadata.pausedAt !== null ||
    metadata.pausedSeconds === undefined ||
    metadata.durationSeconds + metadata.pausedSeconds !== wallSeconds
  ) {
    throw new Error("backup_invalid_timer");
  }
  return {
    timerState: metadata.timerState,
    durationSeconds: metadata.durationSeconds,
    pausedSeconds: metadata.pausedSeconds
  };
}

const restoreSchema = z.object({
  version: z.literal(1),
  settings: z
    .object({
      accentTheme: z.unknown().optional(),
      unitPreferences: z.unknown().optional()
    })
    .optional(),
  babies: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      birthDate: backupDateTime.nullable().optional(),
      timezone: z.string().default("UTC"),
      notes: z.string().nullable().optional(),
      inactiveAt: backupDateTime.nullable().optional()
    })
  ),
  activities: z.array(z.record(z.string(), z.unknown())).default([])
});

type FreshState = { actorIsSoleOwner: boolean; operationalCount: bigint | number };

async function isFreshTarget(db: Pick<Prisma.TransactionClient, "$queryRaw">, ctx: Awaited<ReturnType<typeof getEffectiveHouseholdContext>>) {
  const rows = await db.$queryRaw<FreshState[]>`
    SELECT
      ((SELECT COUNT(*) FROM "HouseholdMember" WHERE "householdId" = ${ctx.householdId} AND "deletedAt" IS NULL AND "disabledAt" IS NULL) = 1
       AND EXISTS (SELECT 1 FROM "HouseholdMember" WHERE id = ${ctx.memberId} AND "householdId" = ${ctx.householdId}
         AND role = 'owner'::"HouseholdRole" AND "deletedAt" IS NULL AND "disabledAt" IS NULL)) AS "actorIsSoleOwner",
      ((SELECT COUNT(*) FROM "Baby" WHERE "householdId" = ${ctx.householdId}) +
       (SELECT COUNT(*) FROM "ActivityLog" WHERE "householdId" = ${ctx.householdId}) +
       (SELECT COUNT(*) FROM "Contact" WHERE "householdId" = ${ctx.householdId}) +
       (SELECT COUNT(*) FROM "MedicineCatalog" WHERE "householdId" = ${ctx.householdId}) +
       (SELECT COUNT(*) FROM "CalendarEvent" WHERE "householdId" = ${ctx.householdId}) +
       (SELECT COUNT(*) FROM "Reminder" WHERE "householdId" = ${ctx.householdId}) +
       (SELECT COUNT(*) FROM "Invite" WHERE "householdId" = ${ctx.householdId}) +
       (SELECT COUNT(*) FROM "ApiKey" WHERE "householdId" = ${ctx.householdId}) +
       (SELECT COUNT(*) FROM "WebhookEndpoint" WHERE "householdId" = ${ctx.householdId}) +
       (SELECT COUNT(*) FROM "WebhookDelivery" WHERE "householdId" = ${ctx.householdId}) +
       (SELECT COUNT(*) FROM "PushSubscription" WHERE "householdId" = ${ctx.householdId}) +
       (SELECT COUNT(*) FROM "NotificationPreference" WHERE "householdId" = ${ctx.householdId}) +
       (SELECT COUNT(*) FROM "NotificationLog" WHERE "householdId" = ${ctx.householdId})) AS "operationalCount"
  `;
  const state = rows[0];
  return Boolean(state?.actorIsSoleOwner && Number(state.operationalCount) === 0);
}

async function assertFreshTarget(db: Pick<Prisma.TransactionClient, "$queryRaw">, ctx: Awaited<ReturnType<typeof getEffectiveHouseholdContext>>) {
  if (!(await isFreshTarget(db, ctx))) throw new Error("backup_target_not_empty");
}

/** A backup whose JSON lists photos cannot be complete without them; only its archive can restore it. */
function refusePhotosWithoutArchive(parsed: ParsedBackup) {
  if (parsed.version === 2 && (parsed.backup.payload.feedPhotos?.length ?? 0) > 0) throw new Error("backup_photos_missing");
}

export async function previewBackupJson(raw: unknown) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "backup.manage");
  const parsed = parseRecoveryBackup(raw);
  refusePhotosWithoutArchive(parsed);
  if (parsed.version === 1) prepareLegacyRecovery(parsed);
  await assertFreshTarget(prisma, ctx);
  return backupSummary(parsed);
}

/** Preview an uploaded backup archive, only after every photo in it has been checked. */
export async function previewBackupArchive(filePath: string) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "backup.manage");
  const archive = await openBackupArchive(filePath);
  try {
    await archive.verifyPhotos();
    await assertFreshTarget(prisma, ctx);
    return backupSummary(archive.parsed);
  } finally {
    await archive.close();
  }
}

export async function exportBackupJson() {
  const { snapshot } = await recordHouseholdExport();
  refusePhotosWithoutArchive({ version: 2, legacyPartial: false, checksumVerified: true, backup: snapshot });
  return JSON.stringify(snapshot, null, 2);
}

export type BackupDownload =
  | { kind: "json"; filename: string; body: string }
  | { kind: "archive"; filename: string; stream: ReadableStream<Uint8Array> };

/**
 * The household's backup to download: the same JSON file as always, or - once it has photos - one
 * archive of that JSON and every photo (DEC-PROD-422). Every photo is checked before any of the
 * archive is sent, so a download never ends half-written.
 */
export async function exportBackupForDownload(): Promise<BackupDownload> {
  const { snapshot, householdId } = await recordHouseholdExport();
  const date = new Date().toISOString().slice(0, 10);
  const photos = snapshot.payload.feedPhotos ?? [];
  if (photos.length === 0) return { kind: "json", filename: `cubby-backup-${date}.json`, body: JSON.stringify(snapshot, null, 2) };

  const stored = await prisma.attachment.findMany({
    where: { householdId, id: { in: photos.map((photo) => photo.id) } },
    select: { id: true, storageKey: true }
  });
  const keys = new Map(stored.map((row) => [row.id, row.storageKey]));
  const read = async (photo: (typeof photos)[number]) => {
    const key = keys.get(photo.id);
    if (!key) throw new Error("backup_photo_unavailable");
    try {
      return await readAttachmentObject(attachmentConfig.directory, key, { byteSize: photo.byteSize, sha256: photo.sha256 });
    } catch {
      throw new Error("backup_photo_unavailable");
    }
  };
  for (const photo of photos) await read(photo);
  return { kind: "archive", filename: `cubby-backup-${date}.zip`, stream: backupArchiveStream(snapshot, (_id, photo) => read(photo)) };
}

async function recordHouseholdExport() {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "backup.manage");
  const snapshot = await prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const snapshot = await buildHouseholdV2Snapshot(tx, ctx.householdId);
      await tx.backupRecord.create({
        data: {
          householdId: ctx.householdId,
          actorUserId: ctx.userId,
          kind: "export",
          status: "complete",
          itemCount: summarizeBackupItemCount(snapshot),
          checksum: snapshot.checksum
        }
      });
      await writeAudit(ctx, {
        action: "backup.export",
        entityType: "backup",
        entityId: snapshot.checksum
      }, tx);
      return snapshot;
    },
    { isolationLevel: "RepeatableRead" }
  );
  return { snapshot, householdId: ctx.householdId };
}

export async function exportHouseholdBackupJson(householdId: string, exportedAt = new Date().toISOString()) {
  return prisma.$transaction(
    (tx: Prisma.TransactionClient) => buildHouseholdV2Snapshot(tx, householdId, exportedAt),
    { isolationLevel: "RepeatableRead" }
  );
}

export async function buildHouseholdV2Snapshot(
  tx: BackupSnapshotTransaction,
  householdId: string,
  exportedAt = new Date().toISOString()
) {
  // Comments and reactions travel only with the posts and entries this backup itself carries.
  const carriedFeedParent = {
    OR: [
      { post: { deletedAt: null, OR: [{ babyId: null }, { baby: { deletedAt: null } }] } },
      { activity: { deletedAt: null, baby: { deletedAt: null } } }
    ]
  };
  const [
    household, settings, babies, contacts, catalogs, activities, calendarEvents, reminders, plannedSchedules, feedPosts, feedComments, feedReactions,
    feedPhotos
  ] = await Promise.all([
    tx.household.findUniqueOrThrow({ where: { id: householdId } }),
    tx.householdSettings.findUnique({ where: { householdId } }),
    tx.baby.findMany({ where: { householdId, deletedAt: null }, orderBy: { createdAt: "asc" } }),
    tx.contact.findMany({ where: { householdId, deletedAt: null }, orderBy: { createdAt: "asc" } }),
    tx.medicineCatalog.findMany({ where: { householdId, deletedAt: null }, orderBy: { createdAt: "asc" } }),
    tx.activityLog.findMany({ where: { householdId, deletedAt: null }, include: backupActivityInclude, orderBy: { occurredAt: "asc" } }),
    tx.calendarEvent.findMany({
      where: { householdId, deletedAt: null },
      include: { babies: { select: { babyId: true } }, contacts: { select: { contactId: true } } },
      orderBy: { startTime: "asc" }
    }),
    tx.reminder.findMany({ where: { householdId, deletedAt: null }, orderBy: { createdAt: "asc" } }),
    tx.plannedSchedule.findMany({
      where: { householdId, baby: { deletedAt: null } },
      select: { babyId: true, document: true },
      orderBy: { createdAt: "asc" }
    }),
    tx.feedPost.findMany({
      where: { householdId, deletedAt: null, OR: [{ babyId: null }, { baby: { deletedAt: null } }] },
      select: {
        id: true, babyId: true, body: true, tags: true, occurredAt: true, externalAuthorName: true,
        author: { select: { displayName: true, user: { select: { name: true } } } }
      },
      orderBy: { occurredAt: "asc" }
    }),
    tx.feedComment.findMany({
      where: { householdId, deletedAt: null, ...carriedFeedParent },
      select: {
        id: true, postId: true, activityId: true, body: true, createdAt: true, editedAt: true, externalAuthorName: true,
        author: { select: { displayName: true, user: { select: { name: true } } } }
      },
      orderBy: { createdAt: "asc" }
    }),
    tx.feedReaction.findMany({
      where: { householdId, ...carriedFeedParent },
      select: {
        postId: true, activityId: true, reaction: true, externalReactorName: true,
        member: { select: { displayName: true, user: { select: { name: true } } } }
      },
      orderBy: { createdAt: "asc" }
    }),
    // Photos shown on the posts this backup carries (DEC-PROD-422). Their bytes travel beside it.
    tx.attachment.findMany({
      where: {
        householdId,
        type: "feed_photo",
        state: "available",
        post: { deletedAt: null, OR: [{ babyId: null }, { baby: { deletedAt: null } }] }
      },
      select: { id: true, postId: true, position: true, width: true, height: true, byteSize: true, sha256: true },
      orderBy: [{ postId: "asc" }, { position: "asc" }]
    })
  ]);
  if (activities.some((activity) => activity.timerState === TimerState.running || activity.timerState === TimerState.paused)) {
    throw new Error("backup_active_timer");
  }
  return createV2Backup({
    household: { name: household.name },
    settings: settings
      ? {
          activityOrder: settings.activityOrder ?? undefined,
          activityVisibility: settings.activityVisibility ?? undefined,
          unitPreferences: parseUnitPreferences(settings.unitPreferences),
          dateFormat: settings.dateFormat,
          timeFormat: settings.timeFormat,
          sleepLocations: settings.sleepLocations,
          medicines: settings.medicines,
          supplements: settings.supplements,
          nurseryModeEnabled: settings.nurseryModeEnabled,
          pwaInstallPromptEnabled: settings.pwaInstallPromptEnabled,
          accentTheme: parseAccentTheme(settings.accentTheme)
        }
      : {},
    babies: babies.map((baby) => ({
      id: baby.id,
      name: baby.name,
      birthDate: baby.birthDate?.toISOString() ?? null,
      timezone: baby.timezone,
      notes: baby.notes,
      feedingWarningMinutes: baby.feedingWarningMinutes,
      diaperWarningMinutes: baby.diaperWarningMinutes,
      sleepWarningMinutes: baby.sleepWarningMinutes,
      preferredUnits: baby.preferredUnits,
      inactiveAt: baby.inactiveAt?.toISOString() ?? null
    })),
    contacts: contacts.map(({ id, name, kind, phone, email, address, notes }) => ({ id, name, kind, phone, email, address, notes })),
    catalogs: catalogs.map(({ id, name, typicalDoseSize, unit, doseMinTime, notes, active, isSupplement }) => ({
      id, name, typicalDoseSize: typicalDoseSize == null ? null : String(typicalDoseSize), unit, doseMinTime, notes, active, isSupplement
    })),
    activities: activities.map(activityToInput),
    calendarEvents: calendarEvents.map((event) => ({
      id: event.id,
      title: event.title,
      description: event.description,
      startTime: event.startTime.toISOString(),
      endTime: event.endTime?.toISOString() ?? null,
      allDay: event.allDay,
      eventType: event.eventType,
      location: event.location,
      color: event.color,
      recurring: event.recurring,
      recurrencePattern: event.recurrencePattern,
      recurrenceEnd: event.recurrenceEnd?.toISOString() ?? null,
      customRecurrence: event.customRecurrence,
      reminderMinutes: event.reminderMinutes,
      source: event.source,
      externalCaretakerNames: event.externalCaretakerNames,
      babyIds: event.babies.map((link) => link.babyId),
      contactIds: event.contacts.map((link) => link.contactId)
    })),
    reminders: reminders.map((reminder) => ({
      id: reminder.id,
      babyId: reminder.babyId,
      kind: reminder.kind,
      title: reminder.title,
      cadenceMinutes: reminder.cadenceMinutes,
      dueAt: reminder.dueAt?.toISOString() ?? null,
      enabled: reminder.enabled
    })),
    plannedSchedules: plannedSchedules.map((schedule) => ({
      babyId: schedule.babyId,
      items: plannedScheduleDocumentSchema.parse(schedule.document).items
    })),
    feedPosts: feedPosts.map((post) => ({
      id: post.id,
      babyId: post.babyId,
      body: post.body,
      tags: post.tags,
      occurredAt: post.occurredAt.toISOString(),
      authorName: post.author?.displayName ?? post.author?.user.name ?? post.externalAuthorName ?? "Someone"
    })),
    feedComments: feedComments.map((comment) => ({
      id: comment.id,
      postId: comment.postId,
      activityId: comment.activityId,
      body: comment.body,
      createdAt: comment.createdAt.toISOString(),
      edited: comment.editedAt !== null,
      authorName: comment.author?.displayName ?? comment.author?.user.name ?? comment.externalAuthorName ?? "Someone"
    })),
    feedReactions: feedReactions.map((reaction) => ({
      postId: reaction.postId,
      activityId: reaction.activityId,
      reaction: reaction.reaction,
      name: reaction.member?.displayName ?? reaction.member?.user.name ?? reaction.externalReactorName ?? "Someone"
    })),
    // Left out entirely when there are none, so a household without photos backs up exactly as before.
    ...(feedPhotos.length
      ? {
          feedPhotos: feedPhotos.map((photo) => ({
            id: photo.id,
            postId: photo.postId!,
            position: photo.position!,
            width: photo.width,
            height: photo.height,
            byteSize: photo.byteSize,
            sha256: photo.sha256
          }))
        }
      : {})
  }, exportedAt);
}

export function summarizeBackupItemCount(snapshot: unknown) {
  return Object.values(backupSummary(parseBackup(snapshot)).counts).reduce((total, count) => total + count, 0);
}

function dateValue(date: Date | null | undefined) {
  return date ? date.toISOString() : undefined;
}

function decimalValue(value: unknown) {
  return value == null ? undefined : String(value);
}

type BackupActivity = Prisma.ActivityLogGetPayload<{ include: typeof backupActivityInclude }>;

export function activityToInput(activity: BackupActivity) {
  if (activity.pauseIntervals?.some((pause) => pause.endedAt === null)) {
    throw new Error("backup_invalid_pause_intervals");
  }
  const base = {
    id: activity.id,
    babyId: activity.babyId,
    type: activity.type,
    occurredAt: activity.occurredAt.toISOString(),
    startedAt: activity.startedAt?.toISOString() ?? null,
    endedAt: activity.endedAt?.toISOString() ?? null,
    timezone: activity.timezone,
    notes: activity.notes ?? null,
    source: activity.source ?? "manual",
    externalActorName: activity.externalActorName ?? null,
    timerState: activity.timerState === TimerState.stopped ? ("stopped" as const) : ("none" as const),
    durationSeconds: activity.durationSeconds ?? null,
    pausedAt: null,
    pausedSeconds: activity.pausedSeconds ?? 0,
    pauseTrackingStartedAt: activity.pauseTrackingStartedAt?.toISOString() ?? null,
    pauseTrackingBaselineSeconds: activity.pauseTrackingBaselineSeconds ?? null,
    pauseIntervals: (activity.pauseIntervals ?? []).map((pause) => ({
      startedAt: pause.startedAt.toISOString(),
      endedAt: pause.endedAt!.toISOString()
    })),
    contactId: activity.medicine?.contactId ?? null
  };

  // Which keys a type carries is declared once, in the activity field matrix, so a newly stored field
  // is in the backup by declaration rather than by remembering to add it here.
  const detail = activityDetailRecord(activity as unknown as { type: string } & Record<string, unknown>);
  if (!detail) return { ...base, detail: {} };
  return { ...base, detail: compactDetail(detail, activityBackupDetailKeys(activity.type)) };
}

function compactDetail(source: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = source[key];
      if (value == null) return [];
      if (value instanceof Date) return [[key, value.toISOString()]];
      if (typeof value === "object") return [[key, String(value)]];
      return [[key, value]];
    })
  );
}

type RestoreConfirmation = { confirmation?: string; previewChecksum?: string };

type RecoveryContext = Awaited<ReturnType<typeof getEffectiveHouseholdContext>>;
type LockedRecoveryContext = Awaited<ReturnType<typeof lockActorForWrite>>;

/** The one serializable transaction every restore runs in, with its confirmation and target checks. */
async function runRestoreTransaction<T>(
  ctx: RecoveryContext,
  confirmation: RestoreConfirmation,
  work: (lockedCtx: LockedRecoveryContext, tx: Prisma.TransactionClient) => Promise<T>
) {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const lockedCtx = await lockActorForWrite(tx, ctx);
        requirePermission(lockedCtx, "backup.manage");
        const targetHousehold = await tx.household.findUniqueOrThrow({ where: { id: lockedCtx.householdId } });
        if (confirmation.confirmation !== undefined && confirmation.confirmation !== targetHousehold.name) {
          throw new Error("backup_confirmation_mismatch");
        }
        const auditIntegrity = await readHouseholdAuditIntegrity(lockedCtx.householdId, tx);
        if (auditIntegrity.status !== "valid") throw new Error("backup_audit_integrity_unavailable");
        await assertFreshTarget(tx, lockedCtx);
        return work(lockedCtx, tx);
      },
      { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 }
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2034") {
      throw new Error("backup_restore_retry");
    }
    throw error;
  }
}

export async function restoreBackupJson(raw: unknown, confirmation: RestoreConfirmation = {}) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "backup.manage");
  const parsed = parseRecoveryBackup(raw);
  refusePhotosWithoutArchive(parsed);
  const legacy = parsed.version === 1 ? prepareLegacyRecovery(parsed) : null;
  if (parsed.version === 2 && confirmation.previewChecksum !== parsed.backup.checksum) {
    throw new Error("backup_preview_mismatch");
  }
  return runRestoreTransaction(ctx, confirmation, (lockedCtx, tx) =>
    parsed.version === 2
      ? restoreV2InTransaction(parsed, lockedCtx, tx)
      : restoreLegacyInTransaction(parsed, legacy!, lockedCtx, tx)
  );
}

/**
 * Restore an uploaded backup archive (DEC-PROD-145): each photo is checked against its listed digest
 * and stored under a new random name before the restore transaction, which then makes the data and
 * its photos visible together. If anything fails, the photos stored for it are removed again.
 */
export async function restoreBackupArchive(filePath: string, confirmation: RestoreConfirmation = {}) {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "backup.manage");
  const archive = await openBackupArchive(filePath);
  try {
    if (confirmation.previewChecksum !== archive.parsed.backup.checksum) throw new Error("backup_preview_mismatch");
    // Checked again inside the transaction; this spares storing photos for a restore that cannot happen.
    await assertFreshTarget(prisma, ctx);
    const storedKeys = new Map<string, string>();
    try {
      for (const photo of archive.photos) {
        const bytes = await archive.readPhoto(photo.id);
        const storageKey = newAttachmentStorageKey();
        await writeAttachmentObject(attachmentConfig.directory, storageKey, bytes, { byteSize: photo.byteSize, sha256: photo.sha256 });
        storedKeys.set(photo.id, storageKey);
      }
      return await runRestoreTransaction(ctx, confirmation, (lockedCtx, tx) => restoreV2InTransaction(archive.parsed, lockedCtx, tx, storedKeys));
    } catch (error) {
      for (const storageKey of storedKeys.values()) {
        await removeAttachmentObject(attachmentConfig.directory, storageKey).catch(() => undefined);
      }
      throw error;
    }
  } finally {
    await archive.close();
  }
}

function parseRecoveryBackup(raw: unknown) {
  try {
    return parseBackup(raw);
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error("backup_invalid");
    throw error;
  }
}

function prepareLegacyRecovery(parsed: Extract<ParsedBackup, { version: 1 }>) {
  try {
    return prepareLegacyRestore(parsed);
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error("backup_invalid");
    throw error;
  }
}

function prepareLegacyRestore(parsed: Extract<ParsedBackup, { version: 1 }>) {
  const input = restoreSchema.parse(parsed.backup);
  const babyIds = new Set(input.babies.map((baby) => baby.id));
  if (babyIds.size !== input.babies.length) throw new Error("backup_duplicate_source_id");
  const activities = input.activities.map((rawActivity) => {
    const { contactId: _contactId, documentUrl: _documentUrl, ...safeActivity } = rawActivity;
    const activity = activityRestoreSchema.parse(safeActivity);
    backupDateTime.parse(activity.occurredAt);
    if (activity.startedAt) backupDateTime.parse(activity.startedAt);
    if (activity.endedAt) backupDateTime.parse(activity.endedAt);
    if (activity.type === "vaccine" && activity.dueDate) backupDateTime.parse(activity.dueDate);
    return { input: activity, timer: parseHistoricalTimerMetadata(rawActivity, activity) };
  });
  if (activities.some(({ input: activity }) => !babyIds.has(activity.babyId))) {
    throw new Error("backup_dangling_reference");
  }
  return { input, activities };
}

async function restoreV2InTransaction(
  parsed: Extract<ParsedBackup, { version: 2 }>,
  lockedCtx: Awaited<ReturnType<typeof lockActorForWrite>>,
  tx: Prisma.TransactionClient,
  // The new storage name of each photo already stored from the archive, by its id in the backup.
  photoStorageKeys: ReadonlyMap<string, string> = new Map()
) {
  const payload = parsed.backup.payload;
  const settings = {
    ...(payload.settings.dateFormat === undefined ? {} : { dateFormat: payload.settings.dateFormat }),
    ...(payload.settings.timeFormat === undefined ? {} : { timeFormat: payload.settings.timeFormat }),
    ...(payload.settings.sleepLocations === undefined ? {} : { sleepLocations: payload.settings.sleepLocations }),
    ...(payload.settings.medicines === undefined ? {} : { medicines: payload.settings.medicines }),
    ...(payload.settings.supplements === undefined ? {} : { supplements: payload.settings.supplements }),
    ...(payload.settings.nurseryModeEnabled === undefined ? {} : { nurseryModeEnabled: payload.settings.nurseryModeEnabled }),
    ...(payload.settings.pwaInstallPromptEnabled === undefined ? {} : { pwaInstallPromptEnabled: payload.settings.pwaInstallPromptEnabled }),
    ...(payload.settings.accentTheme === undefined ? {} : { accentTheme: parseAccentTheme(payload.settings.accentTheme) }),
    ...(payload.settings.unitPreferences === undefined
      ? {}
      : { unitPreferences: parseUnitPreferences(payload.settings.unitPreferences) as Prisma.InputJsonValue }),
    ...(payload.settings.activityOrder === undefined ? {} : { activityOrder: payload.settings.activityOrder as Prisma.InputJsonValue }),
    ...(payload.settings.activityVisibility === undefined ? {} : { activityVisibility: payload.settings.activityVisibility as Prisma.InputJsonValue })
  };
  await tx.household.update({ where: { id: lockedCtx.householdId }, data: { name: payload.household.name } });
  await tx.householdSettings.upsert({
    where: { householdId: lockedCtx.householdId },
    update: settings,
    create: { householdId: lockedCtx.householdId, ...settings }
  });

  const contactMap = new Map<string, string>();
  for (const contact of payload.contacts) {
    const saved = await tx.contact.create({
      data: { householdId: lockedCtx.householdId, name: contact.name, kind: contact.kind, phone: contact.phone, email: contact.email, address: contact.address, notes: contact.notes }
    });
    contactMap.set(contact.id, saved.id);
  }
  for (const catalog of payload.catalogs) {
    await tx.medicineCatalog.create({
      data: {
        householdId: lockedCtx.householdId,
        name: catalog.name,
        typicalDoseSize: catalog.typicalDoseSize,
        unit: catalog.unit,
        doseMinTime: catalog.doseMinTime,
        notes: catalog.notes,
        active: catalog.active,
        isSupplement: catalog.isSupplement
      }
    });
  }

  const babyMap = new Map<string, string>();
  const createdBabies = new Map<string, Awaited<ReturnType<typeof lockBabyForWrite>>>();
  for (const baby of payload.babies) {
    const saved = await tx.baby.create({
      data: {
        householdId: lockedCtx.householdId,
        name: baby.name,
        birthDate: baby.birthDate ? new Date(baby.birthDate) : null,
        timezone: baby.timezone,
        notes: baby.notes,
        feedingWarningMinutes: baby.feedingWarningMinutes,
        diaperWarningMinutes: baby.diaperWarningMinutes,
        sleepWarningMinutes: baby.sleepWarningMinutes,
        ...(baby.preferredUnits == null ? {} : { preferredUnits: baby.preferredUnits as Prisma.InputJsonValue })
      }
    });
    babyMap.set(baby.id, saved.id);
    createdBabies.set(saved.id, saved as Awaited<ReturnType<typeof lockBabyForWrite>>);
  }

  const activityMap = new Map<string, string>();
  for (const activity of payload.activities) {
    const targetBabyId = babyMap.get(activity.babyId)!;
    const targetContactId = activity.contactId ? contactMap.get(activity.contactId)! : undefined;
    const input = activityRestoreSchema.parse({
      ...activity.detail,
      babyId: targetBabyId,
      type: activity.type,
      occurredAt: activity.occurredAt,
      startedAt: activity.startedAt ?? undefined,
      endedAt: activity.endedAt ?? undefined,
      timezone: activity.timezone,
      notes: activity.notes ?? undefined,
      activeTimer: false,
      contactId: targetContactId,
      documentUrl: undefined
    });
    const timer = activity.timerState === "stopped"
      ? { timerState: TimerState.stopped, durationSeconds: activity.durationSeconds!, pausedSeconds: activity.pausedSeconds }
      : undefined;
    const restoredActivity = await restoreHistoricalActivityForContext(input, lockedCtx, tx, timer, {
      source: activity.source,
      externalActorName: activity.externalActorName
    }, {
      startedAt: activity.startedAt ? new Date(activity.startedAt) : null,
      endedAt: activity.endedAt ? new Date(activity.endedAt) : null,
      timezone: activity.timezone,
      pauseTrackingStartedAt: activity.pauseTrackingStartedAt ? new Date(activity.pauseTrackingStartedAt) : null,
      pauseTrackingBaselineSeconds: activity.pauseTrackingBaselineSeconds ?? null,
      pauseIntervals: (activity.pauseIntervals ?? []).map((pause) => ({
        startedAt: new Date(pause.startedAt),
        endedAt: new Date(pause.endedAt)
      }))
    });
    activityMap.set(activity.id, restoredActivity.id);
  }

  for (const event of payload.calendarEvents) {
    await tx.calendarEvent.create({
      data: {
        householdId: lockedCtx.householdId,
        title: event.title,
        description: event.description,
        startTime: new Date(event.startTime),
        endTime: event.endTime ? new Date(event.endTime) : null,
        allDay: event.allDay,
        eventType: event.eventType,
        location: event.location,
        color: event.color,
        recurring: event.recurring,
        recurrencePattern: event.recurrencePattern,
        recurrenceEnd: event.recurrenceEnd ? new Date(event.recurrenceEnd) : null,
        customRecurrence: event.customRecurrence,
        reminderMinutes: event.reminderMinutes,
        source: event.source,
        externalCaretakerNames: event.externalCaretakerNames,
        babies: { create: event.babyIds.map((id) => ({ babyId: babyMap.get(id)! })) },
        contacts: { create: event.contactIds.map((id) => ({ contactId: contactMap.get(id)! })) }
      }
    });
  }
  for (const reminder of payload.reminders) {
    await tx.reminder.create({
      data: {
        householdId: lockedCtx.householdId,
        babyId: babyMap.get(reminder.babyId)!,
        kind: reminder.kind,
        title: reminder.title,
        cadenceMinutes: reminder.cadenceMinutes,
        dueAt: reminder.dueAt ? new Date(reminder.dueAt) : null,
        enabled: reminder.enabled
      }
    });
  }
  for (const schedule of payload.plannedSchedules ?? []) {
    await tx.plannedSchedule.create({
      data: {
        householdId: lockedCtx.householdId,
        babyId: babyMap.get(schedule.babyId)!,
        document: { schemaVersion: PLANNED_SCHEDULE_SCHEMA_VERSION, items: schedule.items } as Prisma.InputJsonValue
      }
    });
  }
  const postMap = new Map<string, string>();
  for (const post of payload.feedPosts ?? []) {
    const saved = await tx.feedPost.create({
      data: {
        householdId: lockedCtx.householdId,
        babyId: post.babyId === null ? null : babyMap.get(post.babyId)!,
        externalAuthorName: post.authorName,
        body: post.body,
        tags: post.tags,
        occurredAt: new Date(post.occurredAt)
      }
    });
    postMap.set(post.id, saved.id);
  }
  const feedParent = (item: { postId: string | null; activityId: string | null }) => ({
    postId: item.postId === null ? null : postMap.get(item.postId)!,
    activityId: item.activityId === null ? null : activityMap.get(item.activityId)!
  });
  for (const comment of payload.feedComments ?? []) {
    const createdAt = new Date(comment.createdAt);
    await tx.feedComment.create({
      data: {
        householdId: lockedCtx.householdId,
        ...feedParent(comment),
        externalAuthorName: comment.authorName,
        body: comment.body,
        createdAt,
        // When it was edited is not carried, only that it was.
        editedAt: comment.edited ? createdAt : null
      }
    });
  }
  for (const reaction of payload.feedReactions ?? []) {
    await tx.feedReaction.create({
      data: { householdId: lockedCtx.householdId, ...feedParent(reaction), externalReactorName: reaction.name, reaction: reaction.reaction }
    });
  }
  const activatedAt = new Date();
  for (const photo of payload.feedPhotos ?? []) {
    const storageKey = photoStorageKeys.get(photo.id);
    if (!storageKey) throw new Error("backup_photos_missing");
    await tx.attachment.create({
      data: {
        householdId: lockedCtx.householdId,
        type: "feed_photo",
        state: "available",
        storageKey,
        byteSize: photo.byteSize,
        sha256: photo.sha256,
        mimeType: "image/jpeg",
        width: photo.width,
        height: photo.height,
        postId: postMap.get(photo.postId)!,
        position: photo.position,
        activatedAt
      }
    });
  }
  for (const baby of payload.babies) {
    if (!baby.inactiveAt) continue;
    const babyId = babyMap.get(baby.id)!;
    const current = createdBabies.get(babyId)!;
    createdBabies.set(babyId, await applyRestoredBabyLifecycle(tx, lockedCtx, current, new Date(baby.inactiveAt), false));
  }

  const counts = {
    babies: payload.babies.length,
    contacts: payload.contacts.length,
    catalogs: payload.catalogs.length,
    activities: payload.activities.length,
    calendarEvents: payload.calendarEvents.length,
    reminders: payload.reminders.length,
    plannedSchedules: payload.plannedSchedules?.length ?? 0,
    feedPosts: payload.feedPosts?.length ?? 0,
    feedComments: payload.feedComments?.length ?? 0,
    feedReactions: payload.feedReactions?.length ?? 0,
    feedPhotos: payload.feedPhotos?.length ?? 0
  };
  const restored = counts.babies + counts.contacts + counts.catalogs + counts.activities + counts.calendarEvents + counts.reminders
    + counts.plannedSchedules + counts.feedPosts + counts.feedComments + counts.feedReactions + counts.feedPhotos;
  await writeRestoreCompletion(lockedCtx, tx, restored, parsed.backup.checksum, counts);
  return { restored, counts, legacyPartial: false };
}

async function restoreLegacyInTransaction(
  parsed: Extract<ParsedBackup, { version: 1 }>,
  prepared: ReturnType<typeof prepareLegacyRestore>,
  lockedCtx: Awaited<ReturnType<typeof lockActorForWrite>>,
  tx: Prisma.TransactionClient
) {
  const { input, activities } = prepared;
  const hasAccentTheme = input.settings?.accentTheme !== undefined;
  const hasUnitPreferences = input.settings?.unitPreferences !== undefined;
  const settings = {
    ...(hasAccentTheme ? { accentTheme: parseAccentTheme(input.settings?.accentTheme) } : {}),
    ...(hasUnitPreferences ? { unitPreferences: parseUnitPreferences(input.settings?.unitPreferences) as Prisma.InputJsonValue } : {})
  };
  if (hasAccentTheme || hasUnitPreferences) {
    await tx.householdSettings.upsert({ where: { householdId: lockedCtx.householdId }, update: settings, create: { householdId: lockedCtx.householdId, ...settings } });
  }
  const babyMap = new Map<string, string>();
  for (const baby of input.babies) {
    const saved = await tx.baby.create({
      data: { householdId: lockedCtx.householdId, name: baby.name, birthDate: baby.birthDate ? new Date(baby.birthDate) : undefined, timezone: baby.timezone, notes: baby.notes ?? undefined }
    });
    babyMap.set(baby.id, saved.id);
  }
  const lockedBabies = new Map<string, Awaited<ReturnType<typeof lockBabyForWrite>>>();
  for (const babyId of [...babyMap.values()].sort()) lockedBabies.set(babyId, await lockBabyForWrite(tx, lockedCtx, babyId));
  for (const { input: activity, timer } of activities) {
    await restoreHistoricalActivityForContext({ ...activity, babyId: babyMap.get(activity.babyId)! }, lockedCtx, tx, timer);
  }
  for (const baby of input.babies) {
    const babyId = babyMap.get(baby.id)!;
    const current = lockedBabies.get(babyId)!;
    lockedBabies.set(babyId, await applyRestoredBabyLifecycle(tx, lockedCtx, current, baby.inactiveAt ? new Date(baby.inactiveAt) : null, false));
  }
  const counts = { babies: input.babies.length, activities: activities.length };
  const restored = counts.babies + counts.activities;
  await writeRestoreCompletion(lockedCtx, tx, restored, undefined, counts);
  return { restored, counts };
}

async function writeRestoreCompletion(
  ctx: Awaited<ReturnType<typeof lockActorForWrite>>,
  tx: Prisma.TransactionClient,
  itemCount: number,
  checksum: string | undefined,
  counts: Record<string, number>
) {
  await writeAudit(ctx, { action: "backup.restore", entityType: "backup", entityId: checksum ?? "legacy-v1" }, tx);
  await tx.backupRecord.create({ data: { householdId: ctx.householdId, actorUserId: ctx.userId, kind: "restore", status: "complete", itemCount, checksum } });
}

async function applyRestoredBabyLifecycle(
  tx: Prisma.TransactionClient,
  ctx: Awaited<ReturnType<typeof lockActorForWrite>>,
  before: Awaited<ReturnType<typeof lockBabyForWrite>>,
  inactiveAt: Date | null,
  writeLifecycleAudit = true
) {
  if (!before.inactiveAt && inactiveAt) {
    const activeTimer = await tx.activityLog.findFirst({
      where: {
        householdId: ctx.householdId,
        babyId: before.id,
        deletedAt: null,
        timerState: { in: [TimerState.running, TimerState.paused] }
      },
      select: { id: true }
    });
    if (activeTimer) throw new Error("baby_has_active_timer");
  }
  if ((before.inactiveAt?.getTime() ?? null) === (inactiveAt?.getTime() ?? null)) return before;

  const after = await tx.baby.update({ where: { id: before.id }, data: { inactiveAt } });
  if (writeLifecycleAudit && (!before.inactiveAt || !inactiveAt)) {
    await writeAudit(
      ctx,
      {
        action: inactiveAt ? "baby.deactivate" : "baby.reactivate",
        entityType: "baby",
        entityId: before.id,
        before,
        after
      },
      tx
    );
  }
  return after;
}

export async function listBackupRecords() {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "backup.manage");
  return prisma.backupRecord.findMany({
    where: { householdId: ctx.householdId },
    orderBy: { createdAt: "desc" },
    take: 50
  });
}

export async function getBackupRestoreTargetName() {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "backup.manage");
  return (await prisma.household.findUniqueOrThrow({
    where: { id: ctx.householdId },
    select: { name: true }
  })).name;
}

function addHours(when: Date, hours: number) {
  return new Date(when.getTime() + hours * 60 * 60 * 1000);
}

function addMinutes(when: Date, minutes: number) {
  return new Date(when.getTime() + minutes * 60 * 1000);
}

async function scanLocalBackupsForStatus(filenames: readonly string[]) {
  try {
    return await scanLocalBackups(automatedBackupConfig.directory, filenames);
  } catch {
    return [{
      healthy: false as const,
      filename: "local backup directory",
      errorCode: "backup_directory_unavailable"
    }];
  }
}

export async function getAutomatedBackupStatus() {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "backup.manage");

  const recordSelect = {
    id: true,
    createdAt: true,
    status: true,
    error: true,
    checksum: true,
    itemCount: true,
    storageFilename: true
  } as const;
  const recordWhere = { householdId: ctx.householdId, kind: "automated_export" as const };
  const [latestSuccess, latestFailure, linkedRecords] = await Promise.all([
    prisma.backupRecord.findFirst({
      where: { ...recordWhere, status: "complete" },
      orderBy: { createdAt: "desc" },
      select: recordSelect
    }),
    prisma.backupRecord.findFirst({
      where: { ...recordWhere, status: "failed" },
      orderBy: { createdAt: "desc" },
      select: recordSelect
    }),
    prisma.backupRecord.findMany({
      where: {
        householdId: ctx.householdId,
        kind: { in: ["automated_export", "recovery_authorized"] },
        status: "complete",
        storageFilename: { not: null }
      },
      orderBy: { createdAt: "desc" },
      select: recordSelect
    })
  ]);
  const scanned = await scanLocalBackupsForStatus(
    linkedRecords.flatMap((record) => record.storageFilename ? [record.storageFilename] : [])
  );

  const storageUnavailable = scanned.some((file) => file.filename === "local backup directory");
  if (!storageUnavailable) {
    for (const record of linkedRecords) {
      if (!record.storageFilename || scanned.some((file) => file.filename === record.storageFilename)) {
        continue;
      }
      try {
        const file = await readLocalBackup(automatedBackupConfig.directory, record.storageFilename);
        scanned.push(file.checksum === record.checksum
          ? { healthy: true, ...file }
          : { healthy: false, filename: record.storageFilename, errorCode: "backup_checksum_mismatch" });
      } catch {
        scanned.push({ healthy: false, filename: record.storageFilename, errorCode: "backup_file_missing" });
      }
    }
  }
  const visibleVersions = scanned.filter((file) => {
    if (file.filename === "local backup directory") return true;
    const record = linkedRecords.find((candidate) => candidate.storageFilename === file.filename);
    return Boolean(record && (!file.healthy || record.checksum === file.checksum));
  });
  const healthyVersions = visibleVersions.filter((file) => file.healthy);
  const unhealthyVersions = visibleVersions.filter((file) => !file.healthy);

  return {
    config: automatedBackupStatusConfig(automatedBackupConfig),
    latestSuccess: latestSuccess
      ? {
          createdAt: latestSuccess.createdAt.toISOString(),
          checksum: latestSuccess.checksum,
          itemCount: latestSuccess.itemCount
        }
      : null,
    latestFailure: latestFailure
      ? {
          createdAt: latestFailure.createdAt.toISOString(),
          errorCode: latestFailure.error
        }
      : null,
    nextDueAt: !automatedBackupConfig.enabled
      ? null
      : latestFailure && (!latestSuccess || latestFailure.createdAt > latestSuccess.createdAt)
        ? addMinutes(latestFailure.createdAt, automatedBackupConfig.retryMinutes).toISOString()
        : latestSuccess
          ? addHours(latestSuccess.createdAt, automatedBackupConfig.intervalHours).toISOString()
          : null,
    healthyVersionCount: healthyVersions.length,
    versions: visibleVersions.map((file) =>
      file.healthy
        ? {
            filename: file.filename,
            exportedAt: file.exportedAt,
            householdName: file.householdName,
            checksum: file.checksum,
            size: file.size,
            itemCount: file.itemCount,
            healthy: true as const
          }
        : {
            filename: file.filename,
            errorCode: file.errorCode,
            healthy: false as const
          }
    ),
    warnings: unhealthyVersions.map((file) => ({
      filename: file.filename,
      errorCode: file.errorCode
    }))
  };
}

export type LocalBackupDownload =
  | { filename: string; body: Buffer }
  | { filename: string; archivePath: string; size: number };

export async function downloadLocalBackupFile(filename: string): Promise<LocalBackupDownload> {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "backup.manage");
  if (!isLocalBackupFilename(filename)) throw new Error("not_found");
  const linkedRecord = await prisma.backupRecord.findFirst({
    where: {
      householdId: ctx.householdId,
      kind: { in: ["automated_export", "recovery_authorized"] },
      status: "complete",
      storageFilename: filename
    },
    select: { checksum: true, storageFilename: true }
  });
  if (!linkedRecord?.checksum || !linkedRecord.storageFilename) throw new Error("not_found");
  const document = await readLocalBackupDocument(automatedBackupConfig.directory, linkedRecord.storageFilename);
  const file = document.file;
  if (file.checksum !== linkedRecord.checksum) throw new Error("backup_checksum_mismatch");
  // An archive with photos can be large, so it is streamed from its file rather than held in memory.
  if (document.body === null) return { filename: file.filename, archivePath: file.absolutePath, size: file.size };
  return { filename: file.filename, body: document.body };
}
