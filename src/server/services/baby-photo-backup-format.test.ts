/**
 * Baby photos must survive a backup round trip, or enabling the type would let a household store a
 * picture that no recovery point contains.
 *
 * These use the real createV2Backup/parseBackup pair, so a rejected payload throws exactly as the
 * export path would.
 */
import { describe, expect, it } from "vitest";

import { createV2Backup, feedPhotoArchiveName, parseBackup, type V2BackupPayload } from "@/server/services/backup-format";

const exportedAt = new Date("2026-09-30T12:00:00.000Z").toISOString();

function basePayload(): V2BackupPayload {
  return {
    household: { name: "Home" },
    settings: {},
    babies: [{ id: "baby-1", name: "One", birthDate: null, timezone: "UTC", notes: null, inactiveAt: null }],
    contacts: [],
    catalogs: [],
    activities: [],
    calendarEvents: [],
    reminders: []
  } as unknown as V2BackupPayload;
}

const PHOTO = { id: "photo-1", width: 512, height: 512, byteSize: 2048, sha256: "a".repeat(64) };
const POST = {
  id: "post-1",
  babyId: "baby-1",
  body: "body",
  tags: [],
  occurredAt: exportedAt,
  authorName: "Author"
};

function build(extra: Record<string, unknown>) {
  return createV2Backup({ ...basePayload(), ...extra } as V2BackupPayload, exportedAt);
}

describe("baby photos in the backup format", () => {
  it("carries a baby photo owned by a baby, with no post and no position", () => {
    const backup = build({ feedPhotos: [{ ...PHOTO, postId: null, position: null, babyId: "baby-1" }] });
    const parsed = parseBackup(backup);

    expect(parsed.version).toBe(2);
    if (parsed.version !== 2) throw new Error("expected v2");
    expect(parsed.backup.payload.feedPhotos?.[0]).toMatchObject({ id: "photo-1", babyId: "baby-1", postId: null });
  });

  it("carries two baby photos for different babies without calling them duplicates", () => {
    // Uniqueness keyed on postId:position alone makes every baby photo collide on "null:null".
    const payload = basePayload();
    const babies = [...payload.babies, { id: "baby-2", name: "Two", birthDate: null, timezone: "UTC", notes: null, inactiveAt: null }];

    expect(() =>
      build({
        babies,
        feedPhotos: [
          { ...PHOTO, id: "photo-1", postId: null, position: null, babyId: "baby-1" },
          { ...PHOTO, id: "photo-2", postId: null, position: null, babyId: "baby-2" }
        ]
      })
    ).not.toThrow();
  });

  it("refuses a baby photo naming a baby the backup does not carry", () => {
    // The hidden-baby filter drops babies from the export; a photo still pointing at one would
    // restore as an orphan.
    expect(() => build({ feedPhotos: [{ ...PHOTO, postId: null, position: null, babyId: "baby-missing" }] }))
      .toThrow("backup_dangling_reference");
  });

  it("refuses a photo owned by both a post and a baby", () => {
    expect(() => build({ feedPosts: [POST], feedPhotos: [{ ...PHOTO, postId: "post-1", position: 0, babyId: "baby-1" }] }))
      .toThrow();
  });

  it("refuses a photo owned by nothing at all", () => {
    expect(() => build({ feedPhotos: [{ ...PHOTO, postId: null, position: null, babyId: null }] })).toThrow();
  });

  it("still refuses two feed photos in the same position on one post", () => {
    expect(() =>
      build({
        feedPosts: [POST],
        feedPhotos: [
          { ...PHOTO, id: "photo-1", postId: "post-1", position: 0, babyId: null },
          { ...PHOTO, id: "photo-2", postId: "post-1", position: 0, babyId: null }
        ]
      })
    ).toThrow("backup_duplicate_source_id");
  });

  it("still refuses a feed photo whose post is not carried", () => {
    expect(() => build({ feedPhotos: [{ ...PHOTO, postId: "post-missing", position: 0, babyId: null }] }))
      .toThrow("backup_dangling_reference");
  });

  it("still carries an ordinary feed photo on a carried post", () => {
    const backup = build({ feedPosts: [POST], feedPhotos: [{ ...PHOTO, postId: "post-1", position: 0, babyId: null }] });
    const parsed = parseBackup(backup);

    expect(parsed.version).toBe(2);
    if (parsed.version !== 2) throw new Error("expected v2");
    expect(parsed.backup.payload.feedPhotos?.[0]).toMatchObject({ postId: "post-1", position: 0 });
  });
});

describe("baby photo bytes in the archive", () => {
  it("binds a baby photo's bytes into the backup checksum like any other photo", () => {
    // The bytes travel beside backup.json as photos/<id>.jpg and their digest is listed in the
    // payload, so altering either the photo or its digest must break the checksum.
    const backup = build({ feedPhotos: [{ ...PHOTO, postId: null, position: null, babyId: "baby-1" }] });
    const tampered = {
      ...backup,
      payload: {
        ...backup.payload,
        feedPhotos: [{ ...PHOTO, postId: null, position: null, babyId: "baby-1", sha256: "b".repeat(64) }]
      }
    };

    expect(() => parseBackup(tampered)).toThrow("backup_checksum_mismatch");
  });

  it("names a baby photo's bytes by id, so ownership does not change where they live", () => {
    const backup = build({ feedPhotos: [{ ...PHOTO, postId: null, position: null, babyId: "baby-1" }] });
    const parsed = parseBackup(backup);
    if (parsed.version !== 2) throw new Error("expected v2");

    expect(feedPhotoArchiveName(parsed.backup.payload.feedPhotos![0].id)).toBe("photos/photo-1.jpg");
  });
});

describe("backups written before baby photos existed", () => {
  it("still parses and still verifies its checksum", () => {
    // The household already holds backups whose photos carry no babyId key at all. Making the
    // ownership fields nullable must not strand them: if the recomputed canonical payload differed
    // by even an added null, the stored checksum would no longer match and the file would be
    // unrestorable. This is the regression that would quietly cost a household its recovery points.
    const legacy = createV2Backup({
      household: { name: "Home" }, settings: {},
      babies: [{ id: "baby-1", name: "One", birthDate: null, timezone: "UTC", notes: null, inactiveAt: null }],
      contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: [],
      feedPosts: [POST],
      // Exactly the shape the old exporter wrote: a post, a position, and no babyId key.
      feedPhotos: [{ id: "photo-1", postId: "post-1", position: 0, width: 512, height: 512, byteSize: 2048, sha256: "a".repeat(64) }]
    } as unknown as V2BackupPayload, exportedAt);

    const parsed = parseBackup(legacy);

    expect(parsed.version).toBe(2);
    if (parsed.version !== 2) throw new Error("expected v2");
    expect(parsed.checksumVerified).toBe(true);
    const photo = parsed.backup.payload.feedPhotos![0];
    expect(photo).toMatchObject({ postId: "post-1", position: 0 });
    // No babyId was invented, so the payload still canonicalizes to what the checksum covered.
    expect(Object.prototype.hasOwnProperty.call(photo, "babyId")).toBe(false);
  });
});
