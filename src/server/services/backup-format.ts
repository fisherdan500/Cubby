import { createHash } from "node:crypto";
import { z } from "zod";
import { plannedScheduleItemsSchema } from "@/domain/planned-schedule";

export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
export const BACKUP_EXCLUSIONS = [
  "Users, credentials, sessions, and household memberships",
  "Invitations and registration policy",
  "API keys, webhooks, and push/notification state",
  "Audit, import, backup history, warning dismissals, and vaccine attachments",
  "Audit integrity checkpoints and household deletion registry receipts",
  "Browser operation bindings, receipts, tombstones, and integrity state"
] as const;

const id = z.string().min(1).max(200);
const shortString = z.string().max(2_000);
const longString = z.string().max(100_000);
const isoDateTime = z.string().datetime({ offset: true });
const nullableDate = isoDateTime.nullable();
const nullableShort = shortString.nullable();
const nullableInt = z.number().int().nullable();
const nullableBoolean = z.boolean().nullable();
const timerCapableTypes = new Set(["feeding", "sleep", "pumping", "play"]);
const reservedActivityDetailKeys = new Set([
  "babyId", "type", "occurredAt", "startedAt", "endedAt", "timezone", "notes",
  "activeTimer", "contactId", "documentUrl"
]);

const settingsSchema = z
  .object({
    activityOrder: z.unknown().optional(),
    activityVisibility: z.unknown().optional(),
    unitPreferences: z.unknown().optional(),
    dateFormat: shortString.optional(),
    timeFormat: shortString.optional(),
    sleepLocations: z.array(shortString).max(1_000).optional(),
    medicines: z.array(shortString).max(10_000).optional(),
    supplements: z.array(shortString).max(10_000).optional(),
    nurseryModeEnabled: z.boolean().optional(),
    pwaInstallPromptEnabled: z.boolean().optional(),
    accentTheme: shortString.optional()
  })
  .strict();

const babySchema = z
  .object({
    id,
    name: shortString,
    birthDate: nullableDate,
    timezone: shortString,
    notes: longString.nullable(),
    feedingWarningMinutes: nullableInt.optional(),
    diaperWarningMinutes: nullableInt.optional(),
    sleepWarningMinutes: nullableInt.optional(),
    preferredUnits: z.unknown().nullable().optional(),
    inactiveAt: nullableDate
  })
  .strict();

const contactSchema = z
  .object({ id, name: shortString, kind: nullableShort, phone: nullableShort, email: nullableShort, address: nullableShort, notes: longString.nullable() })
  .strict();

const catalogSchema = z
  .object({
    id,
    name: shortString,
    typicalDoseSize: nullableShort,
    unit: nullableShort,
    doseMinTime: nullableShort,
    notes: longString.nullable(),
    active: z.boolean(),
    isSupplement: z.boolean()
  })
  .strict();

const activitySchema = z
  .object({
    id,
    babyId: id,
    type: z.enum(["feeding", "diaper", "sleep", "pumping", "medicine", "measurement", "milestone", "note", "bath", "play", "mood", "supplement", "vaccine", "milk_inventory"]),
    occurredAt: isoDateTime,
    startedAt: nullableDate,
    endedAt: nullableDate,
    timezone: shortString,
    notes: longString.nullable(),
    source: shortString,
    externalActorName: nullableShort,
    timerState: z.enum(["none", "stopped"]),
    durationSeconds: nullableInt,
    pausedAt: z.null(),
    pausedSeconds: z.number().int().nonnegative(),
    pauseTrackingStartedAt: nullableDate.optional(),
    pauseTrackingBaselineSeconds: nullableInt.optional(),
    pauseIntervals: z
      .array(
        z
          .object({
            startedAt: isoDateTime,
            endedAt: isoDateTime
          })
          .strict()
      )
      .max(100_000)
      .optional(),
    contactId: id.nullable(),
    detail: z.record(z.string().max(200), z.unknown())
  })
  .strict();

const calendarEventSchema = z
  .object({
    id,
    title: shortString,
    description: longString.nullable(),
    startTime: isoDateTime,
    endTime: nullableDate,
    allDay: z.boolean(),
    eventType: nullableShort,
    location: nullableShort,
    color: nullableShort,
    recurring: z.boolean(),
    recurrencePattern: nullableShort,
    recurrenceEnd: nullableDate,
    customRecurrence: nullableShort,
    reminderMinutes: nullableInt,
    source: shortString,
    externalCaretakerNames: z.array(shortString).max(10_000),
    babyIds: z.array(id).max(10_000),
    contactIds: z.array(id).max(10_000)
  })
  .strict();

const reminderSchema = z
  .object({
    id,
    babyId: id,
    kind: z.enum(["feeding", "diaper", "medicine", "pumping", "sleep", "play"]),
    title: shortString,
    cadenceMinutes: nullableInt,
    dueAt: nullableDate,
    enabled: z.boolean()
  })
  .strict();

// A caregiver's plan for one baby (DEC-PROD-148). Optional, so backups made before plans existed
// still restore unchanged.
const plannedScheduleSchema = z
  .object({ babyId: id, items: plannedScheduleItemsSchema })
  .strict();

// A family feed post (DEC-PROD-421). Memberships are not in backups, so the author travels as a name.
const feedPostSchema = z
  .object({
    id,
    babyId: id.nullable(),
    // A photo post may have no caption (DEC-PROD-422).
    body: z.string().trim().max(2_000),
    tags: z.array(z.string().min(1).max(40)).max(20),
    occurredAt: isoDateTime,
    authorName: shortString
  })
  .strict();

// Comments and reactions on a post or a logged entry - exactly one - carried by name, like posts.
// A comment keeps whether it was edited, not when.
const exactlyOneParent = (item: { postId: string | null; activityId: string | null }) => (item.postId === null) !== (item.activityId === null);
const feedCommentSchema = z
  .object({
    id,
    postId: id.nullable(),
    activityId: id.nullable(),
    body: z.string().trim().min(1).max(1_000),
    createdAt: isoDateTime,
    edited: z.boolean(),
    authorName: shortString
  })
  .strict()
  .refine(exactlyOneParent, { message: "backup_invalid_feed_parent" });

const feedReactionSchema = z
  .object({
    postId: id.nullable(),
    activityId: id.nullable(),
    // Every reaction ever stored, retired "well_done" included, so an older backup still restores.
    reaction: z.enum(["love", "funny", "aww", "celebrate", "well_done"]),
    name: shortString
  })
  .strict()
  .refine(exactlyOneParent, { message: "backup_invalid_feed_parent" });

// A feed photo (DEC-PROD-422): which post it belongs to and where, its shape, and the size and digest
// of its bytes. The bytes travel beside backup.json in the archive, as photos/<id>.jpg; listing their
// digests here binds them into the backup checksum.
const feedPhotoSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    postId: id,
    position: z.number().int().min(0).max(9),
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
    byteSize: z.number().int().positive().max(25 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

export function feedPhotoArchiveName(photoId: string) {
  return `photos/${photoId}.jpg`;
}

const v2PayloadSchema = z
  .object({
    household: z.object({ name: z.string().min(1).max(200) }).strict(),
    settings: settingsSchema,
    babies: z.array(babySchema).max(10_000),
    contacts: z.array(contactSchema).max(10_000),
    catalogs: z.array(catalogSchema).max(10_000),
    activities: z.array(activitySchema).max(1_000_000),
    calendarEvents: z.array(calendarEventSchema).max(100_000),
    reminders: z.array(reminderSchema).max(100_000),
    plannedSchedules: z.array(plannedScheduleSchema).max(10_000).optional(),
    feedPosts: z.array(feedPostSchema).max(1_000_000).optional(),
    feedComments: z.array(feedCommentSchema).max(1_000_000).optional(),
    feedReactions: z.array(feedReactionSchema).max(1_000_000).optional(),
    feedPhotos: z.array(feedPhotoSchema).max(60_000).optional()
  })
  .strict()
  .superRefine((payload, ctx) => {
    const groups = [
      payload.babies, payload.contacts, payload.catalogs, payload.activities, payload.calendarEvents, payload.reminders,
      payload.feedPosts ?? [], payload.feedComments ?? [], payload.feedPhotos ?? []
    ];
    const photoPlaces = (payload.feedPhotos ?? []).map((photo) => `${photo.postId}:${photo.position}`);
    if (new Set(photoPlaces).size !== photoPlaces.length) {
      ctx.addIssue({ code: "custom", message: "backup_duplicate_source_id" });
    }
    for (const group of groups) {
      if (new Set(group.map((item) => item.id)).size !== group.length) {
        ctx.addIssue({ code: "custom", message: "backup_duplicate_source_id" });
      }
    }
    const plannedSchedules = payload.plannedSchedules ?? [];
    if (new Set(plannedSchedules.map((item) => item.babyId)).size !== plannedSchedules.length) {
      ctx.addIssue({ code: "custom", message: "backup_duplicate_source_id" });
    }
    const babies = new Set(payload.babies.map((item) => item.id));
    const contacts = new Set(payload.contacts.map((item) => item.id));
    const activities = new Set(payload.activities.map((item) => item.id));
    const posts = new Set((payload.feedPosts ?? []).map((item) => item.id));
    const onCarriedParent = (item: { postId: string | null; activityId: string | null }) =>
      item.postId !== null ? posts.has(item.postId) : activities.has(item.activityId!);
    const dangling =
      payload.activities.some((item) => !babies.has(item.babyId) || (item.contactId !== null && !contacts.has(item.contactId))) ||
      payload.calendarEvents.some((item) => item.babyIds.some((value) => !babies.has(value)) || item.contactIds.some((value) => !contacts.has(value))) ||
      payload.reminders.some((item) => !babies.has(item.babyId)) ||
      plannedSchedules.some((item) => !babies.has(item.babyId)) ||
      (payload.feedPosts ?? []).some((item) => item.babyId !== null && !babies.has(item.babyId)) ||
      (payload.feedComments ?? []).some((item) => !onCarriedParent(item)) ||
      (payload.feedReactions ?? []).some((item) => !onCarriedParent(item)) ||
      (payload.feedPhotos ?? []).some((item) => !posts.has(item.postId));
    if (dangling) ctx.addIssue({ code: "custom", message: "backup_dangling_reference" });
    for (const activity of payload.activities) {
      if (Object.keys(activity.detail).some((key) => reservedActivityDetailKeys.has(key))) {
        ctx.addIssue({ code: "custom", message: "backup_reserved_activity_detail" });
      }
      const intervals = activity.pauseIntervals ?? [];
      if (activity.timerState !== "stopped") {
        if (
          activity.timerState !== "none" ||
          activity.pausedAt !== null ||
          activity.pausedSeconds !== 0
        ) {
          ctx.addIssue({ code: "custom", message: "backup_invalid_timer" });
        }
        if (
          activity.pauseTrackingStartedAt != null ||
          activity.pauseTrackingBaselineSeconds != null ||
          intervals.length > 0
        ) {
          ctx.addIssue({ code: "custom", message: "backup_invalid_pause_intervals" });
        }
        continue;
      }
      const wallSeconds = activity.startedAt && activity.endedAt
        ? Math.max(0,
          Math.round(new Date(activity.endedAt).getTime() / 1_000)
            - Math.round(new Date(activity.startedAt).getTime() / 1_000))
        : null;
      const predecessorWallSeconds = activity.startedAt && activity.endedAt
        ? Math.max(0, Math.round(
          (new Date(activity.endedAt).getTime() - new Date(activity.startedAt).getTime()) / 1_000
        ))
        : null;
      const compatibleWallSeconds = wallSeconds === null || predecessorWallSeconds === null
        ? null
        : Math.max(wallSeconds, predecessorWallSeconds);
      if (
        !timerCapableTypes.has(activity.type) ||
        wallSeconds === null ||
        compatibleWallSeconds === null ||
        activity.durationSeconds === null ||
        activity.durationSeconds < 0 ||
        activity.durationSeconds > compatibleWallSeconds ||
        activity.pausedSeconds > compatibleWallSeconds ||
        activity.durationSeconds + activity.pausedSeconds > compatibleWallSeconds ||
        (activity.pauseTrackingStartedAt != null && activity.durationSeconds + activity.pausedSeconds !== wallSeconds)
      ) {
        ctx.addIssue({ code: "custom", message: "backup_invalid_timer" });
      }
      const activityStart = activity.startedAt ? new Date(activity.startedAt).getTime() : Number.NaN;
      const activityEnd = activity.endedAt ? new Date(activity.endedAt).getTime() : Number.NaN;
      const trackingStart = activity.pauseTrackingStartedAt
        ? new Date(activity.pauseTrackingStartedAt).getTime()
        : null;
      const trackingBaselineSeconds = activity.pauseTrackingBaselineSeconds ?? null;
      let previousEnd = activityStart;
      let intervalSeconds = 0;
      let invalidIntervals =
        (trackingStart === null) !== (trackingBaselineSeconds === null) ||
        (trackingBaselineSeconds !== null && (
          trackingBaselineSeconds < 0 ||
          trackingBaselineSeconds > activity.pausedSeconds
        )) ||
        (intervals.length > 0 && trackingStart === null);
      if (trackingStart !== null && (trackingStart < activityStart || trackingStart > activityEnd)) invalidIntervals = true;
      for (const interval of intervals) {
        const intervalStart = new Date(interval.startedAt).getTime();
        const intervalEnd = new Date(interval.endedAt).getTime();
        if (
          intervalStart < activityStart ||
          intervalEnd > activityEnd ||
          intervalEnd < intervalStart ||
          (trackingStart !== null && intervalEnd < trackingStart) ||
          intervalStart < previousEnd
        ) invalidIntervals = true;
        previousEnd = intervalEnd;
        intervalSeconds += Math.max(0,
          Math.round(intervalEnd / 1_000) - Math.round(intervalStart / 1_000));
      }
      if (
        trackingBaselineSeconds !== null &&
        intervalSeconds !== activity.pausedSeconds - trackingBaselineSeconds
      ) invalidIntervals = true;
      if (invalidIntervals) ctx.addIssue({ code: "custom", message: "backup_invalid_pause_intervals" });
    }
  });

export type V2BackupPayload = z.input<typeof v2PayloadSchema>;
export type ParsedV2BackupPayload = z.output<typeof v2PayloadSchema>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort()
        .map(([key, child]) => [key, canonicalValue(child)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

export function payloadChecksum(payload: unknown) {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function createV2Backup(payload: V2BackupPayload, exportedAt = new Date().toISOString()) {
  const parsedPayload = v2PayloadSchema.parse(payload);
  const parsedExportedAt = isoDateTime.parse(exportedAt);
  return {
    format: "cubby-household-backup" as const,
    version: 2 as const,
    exportedAt: parsedExportedAt,
    payload: parsedPayload,
    checksum: payloadChecksum(parsedPayload)
  };
}

const v2EnvelopeSchema = z
  .object({
    format: z.literal("cubby-household-backup"),
    version: z.literal(2),
    exportedAt: isoDateTime,
    payload: v2PayloadSchema,
    checksum: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict();

const legacySchema = z.object({
  version: z.literal(1),
  exportedAt: isoDateTime.optional(),
  household: z.object({ name: shortString.optional() }).optional(),
  settings: z.object({ accentTheme: z.unknown().optional(), unitPreferences: z.unknown().optional() }).optional(),
  babies: z.array(z.record(z.string(), z.unknown())).max(10_000),
  activities: z.array(z.record(z.string(), z.unknown())).max(1_000_000).default([])
});

export type ParsedBackup =
  | { version: 2; legacyPartial: false; checksumVerified: true; backup: z.output<typeof v2EnvelopeSchema> }
  | { version: 1; legacyPartial: true; checksumVerified: false; backup: z.output<typeof legacySchema> };

export function parseBackup(raw: unknown): ParsedBackup {
  if (!raw || typeof raw !== "object") throw new Error("backup_unsupported_version");
  const version = (raw as { version?: unknown }).version;
  if (version === 1) {
    return { version: 1, legacyPartial: true, checksumVerified: false, backup: legacySchema.parse(raw) };
  }
  if (version !== 2 || (raw as { format?: unknown }).format !== "cubby-household-backup") {
    throw new Error("backup_unsupported_version");
  }
  const backup = v2EnvelopeSchema.parse(raw);
  if (payloadChecksum(backup.payload) !== backup.checksum) throw new Error("backup_checksum_mismatch");
  return { version: 2, legacyPartial: false, checksumVerified: true, backup };
}

export function backupSummary(parsed: ParsedBackup) {
  if (parsed.version === 1) {
    return {
      legacyPartial: true,
      checksumVerified: false,
      householdName: parsed.backup.household?.name ?? "Legacy Cubby household",
      exportedAt: parsed.backup.exportedAt ?? null,
      counts: { babies: parsed.backup.babies.length, activities: parsed.backup.activities.length },
      exclusions: [...BACKUP_EXCLUSIONS]
    };
  }
  const payload = parsed.backup.payload;
  return {
    legacyPartial: false,
    checksumVerified: true,
    checksum: parsed.backup.checksum,
    householdName: payload.household.name,
    exportedAt: parsed.backup.exportedAt,
    counts: {
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
    },
    exclusions: [...BACKUP_EXCLUSIONS]
  };
}
