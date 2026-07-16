import { createHash } from "node:crypto";
import { z } from "zod";

export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;
export const BACKUP_EXCLUSIONS = [
  "Users, credentials, sessions, and household memberships",
  "Invitations and registration policy",
  "API keys, webhooks, and push/notification state",
  "Audit, import, backup history, warning dismissals, and vaccine attachments"
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

const v2PayloadSchema = z
  .object({
    household: z.object({ name: z.string().min(1).max(200) }).strict(),
    settings: settingsSchema,
    babies: z.array(babySchema).max(10_000),
    contacts: z.array(contactSchema).max(10_000),
    catalogs: z.array(catalogSchema).max(10_000),
    activities: z.array(activitySchema).max(1_000_000),
    calendarEvents: z.array(calendarEventSchema).max(100_000),
    reminders: z.array(reminderSchema).max(100_000)
  })
  .strict()
  .superRefine((payload, ctx) => {
    const groups = [payload.babies, payload.contacts, payload.catalogs, payload.activities, payload.calendarEvents, payload.reminders];
    for (const group of groups) {
      if (new Set(group.map((item) => item.id)).size !== group.length) {
        ctx.addIssue({ code: "custom", message: "backup_duplicate_source_id" });
      }
    }
    const babies = new Set(payload.babies.map((item) => item.id));
    const contacts = new Set(payload.contacts.map((item) => item.id));
    const dangling =
      payload.activities.some((item) => !babies.has(item.babyId) || (item.contactId !== null && !contacts.has(item.contactId))) ||
      payload.calendarEvents.some((item) => item.babyIds.some((value) => !babies.has(value)) || item.contactIds.some((value) => !contacts.has(value))) ||
      payload.reminders.some((item) => !babies.has(item.babyId));
    if (dangling) ctx.addIssue({ code: "custom", message: "backup_dangling_reference" });
    for (const activity of payload.activities) {
      if (Object.keys(activity.detail).some((key) => reservedActivityDetailKeys.has(key))) {
        ctx.addIssue({ code: "custom", message: "backup_reserved_activity_detail" });
      }
      if (activity.timerState !== "stopped") continue;
      const wallSeconds = activity.startedAt && activity.endedAt
        ? Math.max(0, Math.round((new Date(activity.endedAt).getTime() - new Date(activity.startedAt).getTime()) / 1_000))
        : null;
      if (
        !timerCapableTypes.has(activity.type) ||
        wallSeconds === null ||
        activity.durationSeconds === null ||
        activity.durationSeconds < 0 ||
        activity.durationSeconds + activity.pausedSeconds !== wallSeconds
      ) {
        ctx.addIssue({ code: "custom", message: "backup_invalid_timer" });
      }
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
      reminders: payload.reminders.length
    },
    exclusions: [...BACKUP_EXCLUSIONS]
  };
}
