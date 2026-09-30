/**
 * Profile pictures of people must survive a backup round trip.
 *
 * The lesson this encodes comes from the baby_photo slice: the RESTORE direction is where ownership
 * mistakes do real damage, because a picture restored under the wrong owner is silent corruption that
 * passing format tests do not notice. So member ownership is asserted through the real
 * createV2Backup/parseBackup pair, including the exactly-one-owner rule and the uniqueness key.
 */
import { describe, expect, it } from "vitest";

import { createV2Backup, parseBackup, type V2BackupPayload } from "./backup-format";

const exportedAt = "2026-09-30T12:00:00.000Z";
const sha = "b".repeat(64);

const MEMBER_PHOTO = { id: "photo-m1", postId: null, position: null, memberEmail: "one@example.test", width: 512, height: 512, byteSize: 2048, sha256: sha };

function payload(extra: Partial<V2BackupPayload> = {}): V2BackupPayload {
  return {
    household: { name: "Home" },
    settings: {},
    babies: [{ id: "baby-1", name: "One", birthDate: null, timezone: "UTC", notes: null, inactiveAt: null }],
    contacts: [],
    catalogs: [],
    activities: [],
    calendarEvents: [],
    reminders: [],
    ...extra
  } as unknown as V2BackupPayload;
}

function roundTrip(p: V2BackupPayload) {
  const parsed = parseBackup(createV2Backup(p, exportedAt));
  if (parsed.version !== 2) throw new Error("expected v2");
  return parsed;
}

describe("carrying a person's profile picture through a backup", () => {
  it("keeps member ownership across a round trip, checksum intact", () => {
    const parsed = roundTrip(payload({ members: [{ email: "one@example.test", name: "One", role: "parent", displayName: null, joinedAt: exportedAt, disabledAt: null }], feedPhotos: [MEMBER_PHOTO] } as Partial<V2BackupPayload>));

    expect(parsed.checksumVerified).toBe(true);
    expect(parsed.backup.payload.feedPhotos![0]).toMatchObject({ memberEmail: "one@example.test", postId: null, position: null });
  });

  it("refuses a picture owned by both a member and a post", () => {
    expect(() => createV2Backup(payload({
      members: [{ email: "one@example.test", name: "One", role: "parent", displayName: null, joinedAt: exportedAt, disabledAt: null }],
      feedPosts: [{ id: "post-1", babyId: "baby-1", body: "b", tags: [], occurredAt: exportedAt, authorName: "A" }],
      feedPhotos: [{ ...MEMBER_PHOTO, postId: "post-1", position: 0 }]
    } as Partial<V2BackupPayload>), exportedAt)).toThrow();
  });

  it("refuses a picture owned by both a member and a baby", () => {
    // Three ownership kinds now exist, so "exactly one" has to be checked across all three rather
    // than as a post-versus-other pair.
    expect(() => createV2Backup(payload({
      members: [{ email: "one@example.test", name: "One", role: "parent", displayName: null, joinedAt: exportedAt, disabledAt: null }],
      feedPhotos: [{ ...MEMBER_PHOTO, babyId: "baby-1" }]
    } as Partial<V2BackupPayload>), exportedAt)).toThrow();
  });

  it("refuses a member-owned picture that carries a position", () => {
    // position orders photos within a post; on a profile picture it is meaningless and its presence
    // signals a confused row.
    expect(() => createV2Backup(payload({
      members: [{ email: "one@example.test", name: "One", role: "parent", displayName: null, joinedAt: exportedAt, disabledAt: null }],
      feedPhotos: [{ ...MEMBER_PHOTO, position: 0 }]
    } as Partial<V2BackupPayload>), exportedAt)).toThrow();
  });

  it("refuses a picture naming a member the backup does not carry", () => {
    // Otherwise a restore would land the picture on nobody, or the hidden-member filter would drop
    // the owner and leave an orphan.
    expect(() => createV2Backup(payload({
      members: [],
      feedPhotos: [MEMBER_PHOTO]
    } as Partial<V2BackupPayload>), exportedAt)).toThrow("backup_dangling_reference");
  });

  it("allows two members each to have their own picture", () => {
    // Every member photo has postId null and position null, so a uniqueness key built from those two
    // would collide on "null:null" and reject the second person's picture as a duplicate.
    const parsed = roundTrip(payload({
      members: [{ email: "one@example.test", name: "One", role: "parent", displayName: null, joinedAt: exportedAt, disabledAt: null }, { email: "two@example.test", name: "Two", role: "caretaker", displayName: null, joinedAt: exportedAt, disabledAt: null }],
      feedPhotos: [MEMBER_PHOTO, { ...MEMBER_PHOTO, id: "photo-m2", memberEmail: "two@example.test" }]
    } as Partial<V2BackupPayload>));

    expect(parsed.backup.payload.feedPhotos).toHaveLength(2);
  });

  it("refuses two pictures for the same member", () => {
    expect(() => createV2Backup(payload({
      members: [{ email: "one@example.test", name: "One", role: "parent", displayName: null, joinedAt: exportedAt, disabledAt: null }],
      feedPhotos: [MEMBER_PHOTO, { ...MEMBER_PHOTO, id: "photo-m2" }]
    } as Partial<V2BackupPayload>), exportedAt)).toThrow();
  });

  it("still parses a backup written before profile pictures existed", () => {
    // Those files carry no memberEmail key. If parsing invented one, the recomputed canonical payload
    // would differ from what the stored checksum covered and every existing backup would fail
    // verification.
    const parsed = roundTrip(payload({
      feedPosts: [{ id: "post-1", babyId: "baby-1", body: "b", tags: [], occurredAt: exportedAt, authorName: "A" }],
      feedPhotos: [{ id: "photo-1", postId: "post-1", position: 0, width: 512, height: 512, byteSize: 2048, sha256: sha }]
    } as Partial<V2BackupPayload>));

    expect(parsed.checksumVerified).toBe(true);
    const photo = parsed.backup.payload.feedPhotos![0];
    expect(Object.prototype.hasOwnProperty.call(photo, "memberEmail")).toBe(false);
  });
});
