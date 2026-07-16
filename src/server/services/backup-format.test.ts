import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createV2Backup,
  parseBackup,
  type V2BackupPayload
} from "@/server/services/backup-format";

const exportedAt = "2026-07-15T18:00:00.000Z";

function emptyPayload() {
  return {
    household: { name: "Home" },
    settings: {},
    babies: [],
    contacts: [],
    catalogs: [],
    activities: [],
    calendarEvents: [],
    reminders: []
  };
}

describe("backup v2 format", () => {
  it("creates the exact v2 envelope with a deterministic canonical checksum", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}');

    const first = createV2Backup(emptyPayload(), exportedAt);
    const second = createV2Backup({ ...emptyPayload(), settings: {} }, exportedAt);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      format: "cubby-household-backup",
      version: 2,
      exportedAt,
      checksum: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(Object.keys(first).sort()).toEqual(["checksum", "exportedAt", "format", "payload", "version"]);
    expect(parseBackup(first)).toMatchObject({ version: 2, legacyPartial: false, checksumVerified: true });
  });

  it("validates dates, source IDs, references, versions, integrity, and strict non-secret fields", () => {
    const payload: V2BackupPayload = {
      ...emptyPayload(),
      babies: [{ id: "baby-1", name: "Finley", birthDate: null, timezone: "UTC", notes: null, inactiveAt: null }],
      contacts: [{ id: "contact-1", name: "Doctor", kind: null, phone: null, email: null, address: null, notes: null }],
      activities: [{
        id: "activity-1", babyId: "baby-1", type: "note", occurredAt: exportedAt,
        startedAt: null, endedAt: null, timezone: "UTC", notes: null, source: "manual",
        externalActorName: null, timerState: "none", durationSeconds: null, pausedAt: null,
        pausedSeconds: 0, detail: { text: "safe" }, contactId: null
      }],
      calendarEvents: [{
        id: "event-1", title: "Visit", description: null, startTime: exportedAt, endTime: null,
        allDay: false, eventType: null, location: null, color: null, recurring: false,
        recurrencePattern: null, recurrenceEnd: null, customRecurrence: null, reminderMinutes: null,
        source: "manual", externalCaretakerNames: [], babyIds: ["baby-1"], contactIds: ["contact-1"]
      }],
      reminders: [{ id: "reminder-1", babyId: "baby-1", kind: "sleep", title: "Nap", cadenceMinutes: 60, dueAt: exportedAt, enabled: true }]
    };
    const backup = createV2Backup(payload, exportedAt);
    const parsed = parseBackup(backup);
    expect(parsed.version).toBe(2);
    if (parsed.version !== 2) throw new Error("Expected v2 backup");
    expect(parsed.backup.payload).toEqual(payload);

    expect(() => createV2Backup({ ...payload, babies: [...payload.babies, payload.babies[0]] }, exportedAt)).toThrow("backup_duplicate_source_id");
    expect(() => createV2Backup({ ...payload, reminders: [{ ...payload.reminders[0], babyId: "missing" }] }, exportedAt)).toThrow("backup_dangling_reference");
    expect(() => createV2Backup({ ...payload, activities: [{ ...payload.activities[0], occurredAt: "2026-07-15T18:00:00" }] }, exportedAt)).toThrow();
    expect(() => parseBackup({ ...backup, version: 3 })).toThrow("backup_unsupported_version");
    expect(() => parseBackup({ ...backup, checksum: "0".repeat(64) })).toThrow("backup_checksum_mismatch");
    const withUnknownSecurityField = {
      ...payload,
      household: { name: "Home", password: "secret" }
    } as unknown as V2BackupPayload;
    expect(() => createV2Backup(withUnknownSecurityField, exportedAt)).toThrow();
  });

  it("parses legacy v1 as an explicitly partial backup without a checksum claim", () => {
    expect(parseBackup({ version: 1, household: { name: "Old Home" }, babies: [], activities: [] })).toMatchObject({
      version: 1,
      legacyPartial: true,
      checksumVerified: false
    });
  });

  it("rejects reserved fields smuggled through v2 activity detail", () => {
    const payload: V2BackupPayload = {
      ...emptyPayload(),
      babies: [{ id: "baby-1", name: "Finley", birthDate: null, timezone: "UTC", notes: null, inactiveAt: null }],
      activities: [{
        id: "activity-1", babyId: "baby-1", type: "vaccine", occurredAt: exportedAt,
        startedAt: null, endedAt: null, timezone: "UTC", notes: null, source: "manual",
        externalActorName: null, timerState: "none", durationSeconds: null, pausedAt: null,
        pausedSeconds: 0, detail: { name: "DTaP", babyId: "foreign-baby", documentUrl: "/secret.pdf" }, contactId: null
      }]
    };

    expect(() => createV2Backup(payload, exportedAt)).toThrow("backup_reserved_activity_detail");
  });

  it("canonicalizes object keys independently of localeCompare", () => {
    const original = String.prototype.localeCompare;
    try {
      String.prototype.localeCompare = () => -1;
      expect(canonicalJson({ a: 1, z: 2 })).toBe('{"a":1,"z":2}');
    } finally {
      String.prototype.localeCompare = original;
    }
  });

  it("rejects incoherent v2 timer history", () => {
    const payload: V2BackupPayload = {
      ...emptyPayload(),
      babies: [{ id: "baby-1", name: "Finley", birthDate: null, timezone: "UTC", notes: null, inactiveAt: null }],
      activities: [{
        id: "activity-1", babyId: "baby-1", type: "sleep", occurredAt: exportedAt,
        startedAt: "2026-07-15T17:00:00.000Z", endedAt: exportedAt, timezone: "UTC", notes: null,
        source: "manual", externalActorName: null, timerState: "stopped",
        durationSeconds: null, pausedAt: null, pausedSeconds: 0, detail: {}, contactId: null
      }]
    };

    expect(() => createV2Backup(payload, exportedAt)).toThrow("backup_invalid_timer");
    expect(() => createV2Backup({
      ...payload,
      activities: [{ ...payload.activities[0], durationSeconds: 3_000, pausedSeconds: 700 }]
    }, exportedAt)).toThrow("backup_invalid_timer");
  });
});
