import { TimerState, type Prisma } from "@prisma/client";
import { z } from "zod";
import { automatedBackupStatusConfig } from "@/lib/automated-backup-config";
import { prisma } from "@/lib/db/prisma";
import { automatedBackupConfig } from "@/lib/env";
import { parseAccentTheme } from "@/domain/appearance";
import { parseUnitPreferences } from "@/domain/unit-preferences";
import { activityRestoreSchema } from "@/lib/validation/activity";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { activityInclude, restoreHistoricalActivityForContext } from "@/server/services/activities";
import { writeAudit } from "@/server/services/audit";
import { lockActorForWrite, lockBabyForWrite } from "@/server/services/mutation-locks";
import { backupSummary, createV2Backup, parseBackup, type ParsedBackup } from "@/server/services/backup-format";
import {
  isLocalBackupFilename,
  readLocalBackup,
  readLocalBackupDocument,
  scanLocalBackups
} from "@/server/services/local-backup-storage";

const backupDateTime = z.string().datetime({ offset: true });
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
  "household" | "householdSettings" | "baby" | "contact" | "medicineCatalog" | "activityLog" | "calendarEvent" | "reminder"
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

async function isFreshTarget(db: Pick<Prisma.TransactionClient, "$queryRaw">, ctx: Awaited<ReturnType<typeof getHouseholdContext>>) {
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

async function assertFreshTarget(db: Pick<Prisma.TransactionClient, "$queryRaw">, ctx: Awaited<ReturnType<typeof getHouseholdContext>>) {
  if (!(await isFreshTarget(db, ctx))) throw new Error("backup_target_not_empty");
}

export async function previewBackupJson(raw: unknown) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "backup.manage");
  const parsed = parseRecoveryBackup(raw);
  if (parsed.version === 1) prepareLegacyRecovery(parsed);
  await assertFreshTarget(prisma, ctx);
  return backupSummary(parsed);
}

export async function exportBackupJson() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "backup.manage");
  const snapshot = await prisma.$transaction(
    (tx: Prisma.TransactionClient) => buildHouseholdV2Snapshot(tx, ctx.householdId),
    { isolationLevel: "RepeatableRead" }
  );
  const json = JSON.stringify(snapshot, null, 2);
  await prisma.backupRecord.create({
    data: {
      householdId: ctx.householdId,
      actorUserId: ctx.userId,
      kind: "export",
      status: "complete",
      itemCount: summarizeBackupItemCount(snapshot),
      checksum: snapshot.checksum
    }
  });
  return json;
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
  const [household, settings, babies, contacts, catalogs, activities, calendarEvents, reminders] = await Promise.all([
    tx.household.findUniqueOrThrow({ where: { id: householdId } }),
    tx.householdSettings.findUnique({ where: { householdId } }),
    tx.baby.findMany({ where: { householdId, deletedAt: null }, orderBy: { createdAt: "asc" } }),
    tx.contact.findMany({ where: { householdId, deletedAt: null }, orderBy: { createdAt: "asc" } }),
    tx.medicineCatalog.findMany({ where: { householdId, deletedAt: null }, orderBy: { createdAt: "asc" } }),
    tx.activityLog.findMany({ where: { householdId, deletedAt: null }, include: activityInclude, orderBy: { occurredAt: "asc" } }),
    tx.calendarEvent.findMany({
      where: { householdId, deletedAt: null },
      include: { babies: { select: { babyId: true } }, contacts: { select: { contactId: true } } },
      orderBy: { startTime: "asc" }
    }),
    tx.reminder.findMany({ where: { householdId, deletedAt: null }, orderBy: { createdAt: "asc" } })
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
    }))
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

type BackupActivity = Prisma.ActivityLogGetPayload<{ include: typeof activityInclude }>;

function activityToInput(activity: BackupActivity) {
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
    contactId: activity.medicine?.contactId ?? null
  };

  if (activity.feeding) return { ...base, detail: compactDetail(activity.feeding, ["mode", "amount", "unit", "side", "bottleType", "food", "leftSeconds", "rightSeconds"]) };
  if (activity.diaper) return { ...base, detail: compactDetail(activity.diaper, ["kind", "color", "consistency", "rashConcern", "condition", "blowout", "creamApplied"]) };
  if (activity.sleep) return { ...base, detail: compactDetail(activity.sleep, ["sleepType", "location", "quality"]) };
  if (activity.pumping) return { ...base, detail: compactDetail(activity.pumping, ["amount", "leftAmount", "rightAmount", "unit", "inventoryAction"]) };
  if (activity.medicine) return { ...base, detail: compactDetail(activity.medicine, ["name", "dose", "unit"]) };
  if (activity.measurement) return { ...base, detail: compactDetail(activity.measurement, ["weight", "weightUnit", "length", "lengthUnit", "headCircumference", "headUnit", "temperature", "temperatureUnit", "measurementType"]) };
  if (activity.milestone) return { ...base, detail: compactDetail(activity.milestone, ["title", "category"]) };
  if (activity.note) return { ...base, detail: compactDetail(activity.note, ["text", "category"]) };
  if (activity.bath) return { ...base, detail: compactDetail(activity.bath, ["bathType", "products", "waterTemp"]) };
  if (activity.play) return { ...base, detail: compactDetail(activity.play, ["activityName", "location", "intensity"]) };
  if (activity.mood) return { ...base, detail: compactDetail(activity.mood, ["mood", "intensity", "context"]) };
  if (activity.supplement) return { ...base, detail: compactDetail(activity.supplement, ["name", "dose", "unit"]) };
  if (activity.vaccine) return { ...base, detail: compactDetail(activity.vaccine, ["name", "dose", "lot", "provider", "dueDate"]) };
  if (activity.milkInventory) return { ...base, detail: compactDetail(activity.milkInventory, ["action", "amount", "unit", "storage", "label"]) };
  return { ...base, detail: {} };
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

export async function restoreBackupJson(raw: unknown, confirmation: RestoreConfirmation = {}) {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "backup.manage");
  const parsed = parseRecoveryBackup(raw);
  const legacy = parsed.version === 1 ? prepareLegacyRecovery(parsed) : null;
  if (parsed.version === 2 && confirmation.previewChecksum !== parsed.backup.checksum) {
    throw new Error("backup_preview_mismatch");
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        const lockedCtx = await lockActorForWrite(tx, ctx);
        requirePermission(lockedCtx, "backup.manage");
        const targetHousehold = await tx.household.findUniqueOrThrow({ where: { id: lockedCtx.householdId } });
        if (confirmation.confirmation !== undefined && confirmation.confirmation !== targetHousehold.name) {
          throw new Error("backup_confirmation_mismatch");
        }
        await assertFreshTarget(tx, lockedCtx);
        return parsed.version === 2
          ? restoreV2InTransaction(parsed, lockedCtx, tx)
          : restoreLegacyInTransaction(parsed, legacy!, lockedCtx, tx);
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
  tx: Prisma.TransactionClient
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
    await restoreHistoricalActivityForContext(input, lockedCtx, tx, timer, {
      source: activity.source,
      externalActorName: activity.externalActorName
    }, {
      startedAt: activity.startedAt ? new Date(activity.startedAt) : null,
      endedAt: activity.endedAt ? new Date(activity.endedAt) : null,
      timezone: activity.timezone
    });
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
    reminders: payload.reminders.length
  };
  const restored = counts.babies + counts.contacts + counts.catalogs + counts.activities + counts.calendarEvents + counts.reminders;
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
  await writeAudit(ctx, { action: "backup.restore", entityType: "backup", entityId: checksum ?? "legacy-v1", after: counts }, tx);
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
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "backup.manage");
  return prisma.backupRecord.findMany({
    where: { householdId: ctx.householdId },
    orderBy: { createdAt: "desc" },
    take: 50
  });
}

export async function getBackupRestoreTargetName() {
  const ctx = await getHouseholdContext();
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
  const ctx = await getHouseholdContext();
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

export async function downloadLocalBackupFile(filename: string) {
  const ctx = await getHouseholdContext();
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
  return { filename: file.filename, body: document.body };
}
