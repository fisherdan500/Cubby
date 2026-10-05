import { createHash } from "node:crypto";
import { z } from "zod";
import { plannedScheduleItemsSchema } from "@/domain/planned-schedule";
import { singleMailbox } from "@/lib/validation/email";

export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
export const BACKUP_EXCLUSIONS = [
  "Credentials and sessions (a backup never grants a login)",
  "Memberships — people already in the household are recognised; anyone else must be invited",
  "Push subscriptions, so notification rules come back but each device re-enables push",
  "Invitations and registration policy",
  "API keys, webhooks, and notification delivery history",
  "Audit, import, backup history, and warning dismissals",
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
    // The entry this post belongs to, when a photo was added to a logged entry. Without it the entry
    // and its photo come back as two separate moments and the entry's photo is lost from it.
    activityId: id.nullable().optional(),
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
    // A photo is owned by a post (feed) or by a baby (profile picture), never both and never neither.
    // The post-shaped fields are genuinely absent on a baby photo rather than placeholder values.
    postId: id.nullable(),
    position: z.number().int().min(0).max(9).nullable(),
    babyId: id.nullable().optional(),
    // Email, not an id: memberSchema carries no id, because a restore MATCHES the household's
    // existing members by email rather than recreating them. A member id from the source database
    // would be meaningless on the restoring side.
    memberEmail: z.string().min(3).max(320).nullable().optional(),
    width: z.number().int().positive().max(100_000),
    height: z.number().int().positive().max(100_000),
    byteSize: z.number().int().positive().max(25 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
  .superRefine((photo, ctx) => {
    const postOwned = photo.postId !== null;
    const babyOwned = (photo.babyId ?? null) !== null;
    const memberOwned = (photo.memberEmail ?? null) !== null;
    // EXACTLY one owner of three, counted rather than compared: with three kinds a pairwise check
    // would pass a photo owned by all three. A post-owned photo must keep its position, because the
    // pair is what orders a post's photos and makes them unique within it; the parentless kinds must
    // not carry one, where it would be meaningless.
    const owners = [postOwned, babyOwned, memberOwned].filter(Boolean).length;
    if (owners !== 1 || (postOwned && photo.position === null) || (!postOwned && photo.position !== null)) {
      ctx.addIssue({ code: "custom", message: "backup_photo_ownership" });
    }
  });

export function feedPhotoArchiveName(photoId: string) {
  return `photos/${photoId}.jpg`;
}

/**
 * Who was in the household when the backup was taken, as a record — never as an instruction.
 *
 * There is deliberately no password, hash, token, session or verification field here, and the schema
 * is `.strict()` so a hand-edited file cannot introduce one. The export query cannot reach `Account`
 * or `Session` either, so a backup file can never grant a login.
 *
 * Restore reads `email` ONLY, to recognise people who are ALREADY members of the target household so
 * history and notification rules attach to the right person. `email` is the identity that survives the
 * trip between servers, because member and user ids are local to the install that issued them, and it
 * is validated as a single mailbox so one entry cannot expand into several recipients.
 *
 * `role`, `name`, `displayName`, `joinedAt` and `disabledAt` are carried so the file stays a faithful,
 * human-readable account of the household, and are deliberately NOT applied. A backup is untrusted
 * input: letting it set a role or create a membership would move authority and household entry outside
 * the invitation flow, which is the only place consent is obtained.
 */
const memberSchema = z
  .object({
    email: z
      .string()
      .min(3)
      .max(320)
      .refine((value) => {
        try {
          return singleMailbox(value) === value;
        } catch {
          return false;
        }
      }, "backup_member_email_invalid"),
    name: z.string().min(1).max(200),
    role: z.enum(["owner", "admin", "parent", "caretaker", "read_only"]),
    displayName: z.string().max(200).nullable(),
    joinedAt: isoDateTime,
    disabledAt: nullableDate
  })
  .strict();

/**
 * What a person chose about being notified — never how a device is reached.
 *
 * `channels` and `destinationIds` are deliberately absent. Both name push subscriptions: browser and
 * server specific handles (`endpoint`, `p256dh`, `auth`) issued by one browser on one device, which
 * are not in a backup and are meaningless on another server. Carrying them would restore rows that
 * can never deliver, so a restored preference keeps its rules and the person re-enables push on
 * whatever browser they are now using.
 *
 * Keyed by member email for the same reason memberships are: preference and member ids are local to
 * the install that issued them.
 */
const notificationPreferenceSchema = z
  .object({
    email: z.string().min(3).max(320),
    categories: z.array(z.enum(["timer_overdue", "activity_created", "reminder_due", "moments"])).max(20),
    quietHoursStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    quietHoursEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    interruptionLevel: z.enum(["passive", "normal", "time_sensitive"]),
    babyScope: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("all") }).strict(),
      z.object({ mode: z.literal("selected"), babyIds: z.array(id).max(10_000) }).strict()
    ])
  })
  .strict()
  .superRefine((value, ctx) => {
    // Half a quiet-hours range would silence notifications from a start with no end, so the pair is
    // required together, matching the rule the application itself enforces.
    if ((value.quietHoursStart === undefined) !== (value.quietHoursEnd === undefined)) {
      ctx.addIssue({ code: "custom", message: "backup_quiet_hours_pair_required" });
    }
  });

const v2PayloadSchema = z
  .object({
    household: z.object({ name: z.string().min(1).max(200) }).strict(),
    settings: settingsSchema,
    members: z.array(memberSchema).max(1_000).optional(),
    notificationPreferences: z.array(notificationPreferenceSchema).max(1_000).optional(),
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
    // Keyed by owner: post-owned photos are unique by place within their post, baby-owned photos by
    // baby. Keying every photo on postId:position would collide all baby photos on "null:null".
    const photoPlaces = (payload.feedPhotos ?? []).map((photo) =>
      // Keyed by owner kind: every parentless photo has postId and position null, so a key built
      // from that pair would collide on "null:null" and reject the second person's picture as a
      // duplicate.
      photo.postId !== null
        ? `post:${photo.postId}:${photo.position}`
        : photo.babyId != null ? `baby:${photo.babyId}` : `member:${(photo.memberEmail ?? "").toLowerCase()}`
    );
    if (new Set(photoPlaces).size !== photoPlaces.length) {
      ctx.addIssue({ code: "custom", message: "backup_duplicate_source_id" });
    }
    // Email is the identity members restore onto, so two entries sharing one would collapse two
    // people's history onto a single account. Compared case-insensitively, as mailboxes are matched.
    const memberEmails = (payload.members ?? []).map((entry) => entry.email.toLowerCase());
    if (new Set(memberEmails).size !== memberEmails.length) {
      ctx.addIssue({ code: "custom", message: "backup_duplicate_source_id" });
    }
    // A preference belongs to exactly one member, and its selected babies must be babies this
    // backup carries; otherwise it would restore rules pointing at people or children not here.
    const prefs = payload.notificationPreferences ?? [];
    const prefEmails = prefs.map((entry) => entry.email.toLowerCase());
    if (new Set(prefEmails).size !== prefEmails.length) {
      ctx.addIssue({ code: "custom", message: "backup_duplicate_source_id" });
    }
    const memberEmailSet = new Set(memberEmails);
    const babyIds = new Set(payload.babies.map((baby) => baby.id));
    const danglingPreference = prefs.some((entry) =>
      !memberEmailSet.has(entry.email.toLowerCase())
      || (entry.babyScope.mode === "selected" && entry.babyScope.babyIds.some((babyId) => !babyIds.has(babyId)))
    );
    if (danglingPreference) ctx.addIssue({ code: "custom", message: "backup_dangling_reference" });
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
    const members = new Set((payload.members ?? []).map((item) => item.email.toLowerCase()));
    const onCarriedParent = (item: { postId: string | null; activityId: string | null }) =>
      item.postId !== null ? posts.has(item.postId) : activities.has(item.activityId!);
    const dangling =
      payload.activities.some((item) => !babies.has(item.babyId) || (item.contactId !== null && !contacts.has(item.contactId))) ||
      payload.calendarEvents.some((item) => item.babyIds.some((value) => !babies.has(value)) || item.contactIds.some((value) => !contacts.has(value))) ||
      payload.reminders.some((item) => !babies.has(item.babyId)) ||
      plannedSchedules.some((item) => !babies.has(item.babyId)) ||
      (payload.feedPosts ?? []).some((item) => item.babyId !== null && !babies.has(item.babyId)) ||
      // A photo post names the entry it belongs to; that entry must travel in the same backup.
      (payload.feedPosts ?? []).some((item) => (item.activityId ?? null) !== null && !activities.has(item.activityId!)) ||
      (payload.feedComments ?? []).some((item) => !onCarriedParent(item)) ||
      (payload.feedReactions ?? []).some((item) => !onCarriedParent(item)) ||
      (payload.feedPhotos ?? []).some((item) => {
        if (item.postId !== null) return !posts.has(item.postId);
        if (item.babyId != null) return !babies.has(item.babyId);
        // A profile picture whose member the backup does not carry would restore onto nobody.
        return !members.has((item.memberEmail ?? "").toLowerCase());
      });
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
