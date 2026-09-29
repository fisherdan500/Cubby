import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEffectiveHouseholdContext: vi.fn(),
  intent: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  requirePermission: vi.fn(),
  householdFind: vi.fn(),
  householdCount: vi.fn(),
  householdUpdate: vi.fn(),
  settingsFind: vi.fn(),
  settingsUpsert: vi.fn(),
  babyFindMany: vi.fn(),
  babyFindFirst: vi.fn(),
  babyCreate: vi.fn(),
  babyUpdate: vi.fn(),
  activityFindMany: vi.fn(),
  activityFindFirst: vi.fn(),
  contactFindMany: vi.fn(),
  contactCreate: vi.fn(),
  catalogFindMany: vi.fn(),
  catalogCreate: vi.fn(),
  calendarFindMany: vi.fn(),
  calendarCreate: vi.fn(),
  reminderFindMany: vi.fn(),
  reminderCreate: vi.fn(),
  plannedScheduleFindMany: vi.fn(),
  plannedScheduleCreate: vi.fn(),
  feedPostFindMany: vi.fn(),
  feedPostCreate: vi.fn(),
  feedCommentFindMany: vi.fn(),
  feedCommentCreate: vi.fn(),
  feedReactionFindMany: vi.fn(),
  feedReactionCreate: vi.fn(),
  attachmentFindMany: vi.fn(),
  attachmentCreate: vi.fn(),
  writeObject: vi.fn(),
  readObject: vi.fn(),
  removeObject: vi.fn(),
  openBackupArchive: vi.fn(),
  backupCreate: vi.fn(),
  backupFindMany: vi.fn(),
  backupFindFirst: vi.fn(),
  backupCount: vi.fn(),
  restoreActivity: vi.fn(),
  transaction: vi.fn(),
  lockActor: vi.fn(),
  lockPhotoActor: vi.fn(),
  sessionFind: vi.fn(),
  memberFind: vi.fn(),
  lockBaby: vi.fn(),
  writeAudit: vi.fn(),
  memberCreate: vi.fn(),
  memberFindMany: vi.fn(),
  userFindMany: vi.fn(),
  memberFindFirst: vi.fn(),
  memberUpdate: vi.fn(),
  memberUpdateMany: vi.fn(),
  memberDelete: vi.fn(),
  memberDeleteMany: vi.fn(),
  freshState: vi.fn(),
  isLocalBackupFilename: vi.fn(),
  scanLocalBackups: vi.fn(),
  readLocalBackup: vi.fn(),
  readLocalBackupDocument: vi.fn(),
  readHouseholdAuditIntegrity: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    attachmentWriteIntent: mocks.intent,
    household: {
      findUniqueOrThrow: mocks.householdFind,
      update: mocks.householdUpdate,
      count: mocks.householdCount
    },
    householdSettings: { findUnique: mocks.settingsFind, upsert: mocks.settingsUpsert },
    baby: {
      findMany: mocks.babyFindMany,
      findFirst: mocks.babyFindFirst,
      create: mocks.babyCreate,
      update: mocks.babyUpdate
    },
    activityLog: { findMany: mocks.activityFindMany, findFirst: mocks.activityFindFirst },
    contact: { findMany: mocks.contactFindMany, create: mocks.contactCreate },
    medicineCatalog: { findMany: mocks.catalogFindMany, create: mocks.catalogCreate },
    calendarEvent: { findMany: mocks.calendarFindMany, create: mocks.calendarCreate },
    reminder: { findMany: mocks.reminderFindMany, create: mocks.reminderCreate },
    plannedSchedule: { findMany: mocks.plannedScheduleFindMany, create: mocks.plannedScheduleCreate },
    feedPost: { findMany: mocks.feedPostFindMany, create: mocks.feedPostCreate },
    feedComment: { findMany: mocks.feedCommentFindMany, create: mocks.feedCommentCreate },
    feedReaction: { findMany: mocks.feedReactionFindMany, create: mocks.feedReactionCreate },
    attachment: { findMany: mocks.attachmentFindMany, create: mocks.attachmentCreate },
    backupRecord: {
      create: mocks.backupCreate,
      findMany: mocks.backupFindMany,
      findFirst: mocks.backupFindFirst,
      count: mocks.backupCount
    },
    $queryRaw: mocks.freshState,
    $transaction: mocks.transaction,
    user: { findMany: mocks.userFindMany },
    householdMember: {
      findMany: mocks.memberFindMany,
      findFirst: mocks.memberFindFirst,
      create: mocks.memberCreate,
      update: mocks.memberUpdate,
      updateMany: mocks.memberUpdateMany,
      delete: mocks.memberDelete,
      deleteMany: mocks.memberDeleteMany
    }
  }
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));

vi.mock("@/server/services/activities", () => ({
  activityInclude: {},
  restoreHistoricalActivityForContext: mocks.restoreActivity
}));

vi.mock("@/server/services/mutation-locks", () => ({
  lockActorForWrite: mocks.lockActor,
  lockBabyForWrite: mocks.lockBaby
}));

vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/server/services/browser-operations", () => ({ getBrowserOperationContextForHousehold: mocks.getEffectiveHouseholdContext }));
vi.mock("@/server/services/photo-write-actor", () => ({ lockPhotoWriteActor: mocks.lockPhotoActor }));
vi.mock("@/server/services/attachment-store", () => ({
  writeAttachmentObject: mocks.writeObject,
  readAttachmentObject: mocks.readObject,
  removeAttachmentObject: mocks.removeObject
}));
vi.mock("@/server/services/backup-archive", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/services/backup-archive")>(),
  openBackupArchive: mocks.openBackupArchive
}));
vi.mock("@/server/services/audit-checkpoints", () => ({ readHouseholdAuditIntegrity: mocks.readHouseholdAuditIntegrity }));
vi.mock("@/server/services/local-backup-storage", () => ({
  isLocalBackupFilename: mocks.isLocalBackupFilename,
  scanLocalBackups: mocks.scanLocalBackups,
  readLocalBackup: mocks.readLocalBackup,
  readLocalBackupDocument: mocks.readLocalBackupDocument
}));

import {
  buildHouseholdV2Snapshot,
  downloadLocalBackupFile,
  exportBackupForDownload,
  exportBackupJson,
  exportHouseholdBackupJson,
  getAutomatedBackupStatus,
  previewBackupArchive,
  previewBackupJson,
  restoreBackupArchive,
  restoreBackupJson
} from "@/server/services/backups";
import { openZipStore } from "@/server/services/zip-store";
import { createV2Backup } from "@/server/services/backup-format";

const ctx = {
  userId: "user-1",
  householdId: "household-1",
  memberId: "member-1",
  role: "owner"
};

const unitPreferences = {
  volume: "mL",
  weight: "kg",
  length: "cm",
  temperature: "C",
  medicineUnits: { Acetaminophen: "mL" },
  supplementUnits: { "Vitamin D": "drops" }
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.intent.create.mockImplementation(async ({ data }) => data);
  mocks.intent.findUnique.mockImplementation(async ({ where }) => mocks.intent.create.mock.calls.map(([call]) => call.data).find((row) => row.storageKey === where.storageKey));
  mocks.intent.updateMany.mockResolvedValue({ count: 1 });
  mocks.getEffectiveHouseholdContext.mockResolvedValue(ctx);
  mocks.householdFind.mockResolvedValue({ id: "household-1", name: "Home" });
  mocks.householdCount.mockResolvedValue(1);
  mocks.backupCount.mockResolvedValue(0);
  mocks.backupFindFirst.mockResolvedValue(null);
  mocks.isLocalBackupFilename.mockReturnValue(true);
  mocks.settingsFind.mockResolvedValue({ accentTheme: "sage", unitPreferences });
  mocks.babyFindMany.mockResolvedValue([]);
  mocks.babyFindFirst.mockResolvedValue(null);
  mocks.babyCreate.mockResolvedValue(null);
  mocks.babyUpdate.mockResolvedValue(null);
  mocks.restoreActivity.mockResolvedValue({ id: "activity-restored" });
  mocks.transaction.mockImplementation((operation) => operation({ ...transactionClient(), attachmentWriteIntent: mocks.intent }));
  mocks.lockActor.mockResolvedValue(ctx);
  mocks.lockPhotoActor.mockImplementation((...args) => mocks.lockActor(...args));
  mocks.lockBaby.mockImplementation(async (_tx, _ctx, id) => ({ id, inactiveAt: null }));
  mocks.activityFindMany.mockResolvedValue([]);
  mocks.activityFindFirst.mockResolvedValue(null);
  mocks.contactFindMany.mockResolvedValue([]);
  mocks.catalogFindMany.mockResolvedValue([]);
  mocks.calendarFindMany.mockResolvedValue([]);
  mocks.reminderFindMany.mockResolvedValue([]);
  mocks.plannedScheduleFindMany.mockResolvedValue([]);
  mocks.feedPostFindMany.mockResolvedValue([]);
  mocks.feedPostCreate.mockImplementation(async ({ data }) => ({ id: `saved-${data.body.slice(0, 5)}` }));
  mocks.feedCommentFindMany.mockResolvedValue([]);
  mocks.feedReactionFindMany.mockResolvedValue([]);
  mocks.attachmentFindMany.mockResolvedValue([]);
  mocks.writeObject.mockResolvedValue(undefined);
  mocks.removeObject.mockResolvedValue(undefined);
  mocks.backupCreate.mockResolvedValue({ id: "backup-1" });
  mocks.backupFindMany.mockResolvedValue([]);
  mocks.settingsUpsert.mockResolvedValue({});
  mocks.householdUpdate.mockResolvedValue({ id: "household-1", name: "Recovered Home" });
  mocks.contactCreate.mockResolvedValue({ id: "saved-contact-1" });
  mocks.catalogCreate.mockResolvedValue({ id: "saved-catalog-1" });
  mocks.calendarCreate.mockResolvedValue({ id: "saved-event-1" });
  mocks.reminderCreate.mockResolvedValue({ id: "saved-reminder-1" });
  mocks.freshState.mockResolvedValue([{ actorIsSoleOwner: true, operationalCount: 0n }]);
  mocks.scanLocalBackups.mockResolvedValue([]);
  mocks.readLocalBackup.mockRejectedValue(new Error("backup_invalid"));
  mocks.readLocalBackupDocument.mockResolvedValue({
    file: { filename: "backup.json", checksum: "a".repeat(64) },
    body: Buffer.from("{}")
  });
  mocks.readHouseholdAuditIntegrity.mockResolvedValue({ status: "valid" });
  mocks.memberFindMany.mockResolvedValue([]);
  mocks.userFindMany.mockResolvedValue([]);
  mocks.memberCreate.mockResolvedValue({ id: "saved-member-1" });
  mocks.memberFindFirst.mockResolvedValue(null);
});

describe("backup unit preferences", () => {
  it("previews a valid backup without writes and rejects a populated target", async () => {
    const backup = createV2Backup({
      household: { name: "Recovered Home" }, settings: {}, babies: [], contacts: [], catalogs: [],
      activities: [], calendarEvents: [], reminders: []
    }, "2026-07-15T18:00:00.000Z");

    await expect(previewBackupJson(backup)).resolves.toMatchObject({
      householdName: "Recovered Home", legacyPartial: false, checksumVerified: true,
      counts: { babies: 0, activities: 0 }
    });
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "backup.manage");
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.backupCreate).not.toHaveBeenCalled();

    mocks.freshState.mockResolvedValue([{ actorIsSoleOwner: true, operationalCount: 1n }]);
    await expect(previewBackupJson(backup)).rejects.toThrow("backup_target_not_empty");
  });

  it("labels malformed v2 and legacy backup schemas as backup-specific invalid files", async () => {
    await expect(previewBackupJson({
      format: "cubby-household-backup",
      version: 2,
      exportedAt: "not-a-date",
      payload: {},
      checksum: "0".repeat(64)
    })).rejects.toThrow("backup_invalid");

    const malformedLegacy = {
      version: 1,
      babies: [{ id: "source-baby", timezone: "UTC" }],
      activities: []
    };
    await expect(previewBackupJson(malformedLegacy)).rejects.toThrow("backup_invalid");
    await expect(restoreBackupJson(malformedLegacy)).rejects.toThrow("backup_invalid");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(["missing", "stale", "invalid"])("rejects %s audit checkpoint evidence before restore writes", async (status) => {
    mocks.readHouseholdAuditIntegrity.mockResolvedValue({ status });

    await expect(restoreBackupJson({ version: 1, babies: [], activities: [] })).rejects.toThrow("backup_audit_integrity_unavailable");

    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.babyCreate).not.toHaveBeenCalled();
    expect(mocks.backupCreate).not.toHaveBeenCalled();
  });

  it("accepts a pristine household, which is the fresh install a restore is meant to land on", async () => {
    // A household that has never written an audit event has no chain to verify, so there is nothing
    // to have been tampered with. Refusing it made restoring onto a new server impossible. `missing`
    // (events present, checkpoint gone) stays refused by the case above.
    mocks.readHouseholdAuditIntegrity.mockResolvedValue({ status: "pristine" });

    await expect(restoreBackupJson({ version: 1, babies: [], activities: [] })).resolves.toBeDefined();

    expect(mocks.backupCreate).toHaveBeenCalled();
  });

  it.each(["FeedPost", "FeedComment", "FeedReaction", "Attachment", "PlannedSchedule"])("refuses a target containing only newer %s domain data", async (table) => {
    mocks.freshState.mockImplementation(async (sql: TemplateStringsArray) => [{
      actorIsSoleOwner: true, operationalCount: sql.join("").includes(`FROM "${table}"`) ? 1n : 0n
    }]);
    const backup = { version: 1, babies: [], activities: [] };
    await expect(restoreBackupJson(backup)).rejects.toThrow("backup_target_not_empty");
    await expect(previewBackupJson(backup)).rejects.toThrow("backup_target_not_empty");
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.backupCreate).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
  });

  it.each([1, 2])("refuses v%s JSON restore when captured session was revoked before transaction authority", async (version) => {
    const { lockPhotoWriteActor } = await vi.importActual<typeof import("./photo-write-actor")>("./photo-write-actor");
    mocks.lockPhotoActor.mockImplementation(lockPhotoWriteActor);
    mocks.getEffectiveHouseholdContext.mockResolvedValue({ ...ctx, sessionId: "captured-session" });
    mocks.sessionFind.mockResolvedValue(null);
    mocks.memberFind.mockResolvedValue(ctx);
    const backup = version === 1 ? { version: 1, settings: { accentTheme: "sage" }, babies: [], activities: [] }
      : createV2Backup({ household: { name: "Recovered" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: [] });
    await expect(restoreBackupJson(backup, { confirmation: "Home", previewChecksum: "checksum" in backup ? backup.checksum : undefined })).rejects.toThrow("forbidden");
    expect(mocks.sessionFind).toHaveBeenCalledWith({ where: { id: "captured-session", userId: ctx.userId, expiresAt: { gt: expect.any(Date) } } });
    expect(mocks.memberFind).not.toHaveBeenCalled();
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.householdUpdate).not.toHaveBeenCalled();
    expect(mocks.babyCreate).not.toHaveBeenCalled();
    expect(mocks.backupCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("uses session-before-member authority for restore-first synthetic ordering (not PostgreSQL)", async () => {
    const { lockPhotoWriteActor } = await vi.importActual<typeof import("./photo-write-actor")>("./photo-write-actor");
    mocks.lockPhotoActor.mockImplementation(lockPhotoWriteActor);
    mocks.getEffectiveHouseholdContext.mockResolvedValue({ ...ctx, sessionId: "captured-session" });
    const events: string[] = [];
    let revoked = false;
    mocks.sessionFind.mockImplementation(async () => { events.push("session-read"); return revoked ? null : { id: "captured-session" }; });
    mocks.memberFind.mockImplementation(async () => { events.push("member-read"); return ctx; });
    mocks.transaction.mockImplementation(async (work) => {
      const tx = transactionClient();
      const query = tx.$queryRaw;
      tx.$queryRaw = (sql, ...args) => {
        if (sql.join("").includes("lock_actor_session_for_operation")) events.push("session-lock");
        if (sql.join("").includes("FOR UPDATE")) events.push("member-lock");
        return query(sql, ...args);
      };
      const result = await work(tx);
      events.push("restore-commit");
      // Models a revoker ordered behind the restore's session lock, not a real database race.
      revoked = true;
      events.push("revocation-commit");
      return result;
    });
    await restoreBackupJson({ version: 1, settings: { accentTheme: "sage" }, babies: [], activities: [] }, { confirmation: "Home" });
    expect(events).toEqual(["session-lock", "session-read", "member-lock", "member-read", "restore-commit", "revocation-commit"]);
    expect(mocks.settingsUpsert).toHaveBeenCalledOnce();
    expect(mocks.backupCreate).toHaveBeenCalledOnce();
    expect(mocks.writeAudit).toHaveBeenCalledOnce();
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 });
  });

  it("rechecks target emptiness inside the serializable restore transaction", async () => {
    mocks.freshState.mockResolvedValue([{ actorIsSoleOwner: true, operationalCount: 1n }]);

    await expect(restoreBackupJson({ version: 1, babies: [], activities: [] })).rejects.toThrow("backup_target_not_empty");

    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.backupCreate).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
  });

  it("carries each baby's planned schedule through export and restore", async () => {
    const items = [{ kind: "bedtime", label: null, timing: { mode: "exact", at: "19:15" }, note: "Two books" }];
    mocks.babyFindMany.mockResolvedValue([{
      id: "baby-1", name: "Finley", birthDate: null, timezone: "UTC", notes: null, feedingWarningMinutes: null,
      diaperWarningMinutes: null, sleepWarningMinutes: null, preferredUnits: null, inactiveAt: null
    }]);
    mocks.plannedScheduleFindMany.mockResolvedValue([{ babyId: "baby-1", document: { schemaVersion: 1, items } }]);
    const exported = await buildHouseholdV2Snapshot(
      transactionClient() as unknown as Parameters<typeof buildHouseholdV2Snapshot>[0],
      "household-1",
      "2026-09-24T18:00:00.000Z"
    );
    expect(exported.payload.plannedSchedules).toEqual([{ babyId: "baby-1", items }]);

    mocks.babyCreate.mockResolvedValue({ id: "saved-baby-1", name: "Finley", inactiveAt: null });
    await expect(restoreBackupJson(exported, { confirmation: "Home", previewChecksum: exported.checksum })).resolves.toMatchObject({
      counts: { babies: 1, plannedSchedules: 1 }
    });
    expect(mocks.plannedScheduleCreate).toHaveBeenCalledWith({
      data: { householdId: "household-1", babyId: "saved-baby-1", document: { schemaVersion: 1, items } }
    });
  });

  it("carries family feed posts through export and restore, keeping the author's name", async () => {
    mocks.babyFindMany.mockResolvedValue([{
      id: "baby-1", name: "Finley", birthDate: null, timezone: "UTC", notes: null, feedingWarningMinutes: null,
      diaperWarningMinutes: null, sleepWarningMinutes: null, preferredUnits: null, inactiveAt: null
    }]);
    mocks.feedPostFindMany.mockResolvedValue([
      { id: "post-1", babyId: "baby-1", body: "First bath #firsts", tags: ["firsts"], occurredAt: new Date("2026-09-20T10:00:00Z"), externalAuthorName: null, author: { displayName: "Sam", user: { name: "Sam P" } } },
      { id: "post-2", babyId: null, body: "Family walk", tags: [], occurredAt: new Date("2026-09-21T10:00:00Z"), externalAuthorName: null, author: { displayName: null, user: { name: "Alex" } } }
    ]);
    const exported = await buildHouseholdV2Snapshot(
      transactionClient() as unknown as Parameters<typeof buildHouseholdV2Snapshot>[0],
      "household-1",
      "2026-09-24T18:00:00.000Z"
    );
    expect(exported.payload.feedPosts?.map((post) => [post.id, post.babyId, post.authorName])).toEqual([["post-1", "baby-1", "Sam"], ["post-2", null, "Alex"]]);

    mocks.babyCreate.mockResolvedValue({ id: "saved-baby-1", name: "Finley", inactiveAt: null });
    await expect(restoreBackupJson(exported, { confirmation: "Home", previewChecksum: exported.checksum })).resolves.toMatchObject({
      counts: { feedPosts: 2 }
    });
    // Memberships are not restored, so the post keeps who wrote it by name.
    expect(mocks.feedPostCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ babyId: "saved-baby-1", externalAuthorName: "Sam", tags: ["firsts"] }) });
    expect(mocks.feedPostCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ babyId: null, externalAuthorName: "Alex" }) });
  });

  it("exports the live comments and the reactions with the names of who wrote and chose them", async () => {
    mocks.feedPostFindMany.mockResolvedValue([
      { id: "post-1", babyId: null, body: "Family walk", tags: [], occurredAt: new Date("2026-09-21T10:00:00Z"), externalAuthorName: null, author: { displayName: "Alex", user: { name: "Alex" } } }
    ]);
    mocks.feedCommentFindMany.mockResolvedValue([
      {
        id: "comment-1", postId: "post-1", activityId: null, body: "Lovely", createdAt: new Date("2026-09-21T11:00:00Z"),
        editedAt: new Date("2026-09-21T11:05:00Z"), externalAuthorName: null, author: { displayName: "Sam", user: { name: "Sam P" } }
      }
    ]);
    mocks.feedReactionFindMany.mockResolvedValue([
      { postId: "post-1", activityId: null, reaction: "well_done", externalReactorName: null, member: { displayName: null, user: { name: "Jo" } } }
    ]);

    const exported = await buildHouseholdV2Snapshot(
      transactionClient() as unknown as Parameters<typeof buildHouseholdV2Snapshot>[0],
      "household-1",
      "2026-09-27T18:00:00.000Z"
    );

    // Only comments and reactions on posts and entries the backup itself carries.
    expect(mocks.feedCommentFindMany.mock.calls[0][0].where).toEqual({
      householdId: "household-1",
      deletedAt: null,
      OR: [
        { post: { deletedAt: null, OR: [{ babyId: null }, { baby: { deletedAt: null } }] } },
        { activity: { deletedAt: null, baby: { deletedAt: null } } }
      ]
    });
    expect(exported.payload.feedComments).toEqual([
      { id: "comment-1", postId: "post-1", activityId: null, body: "Lovely", createdAt: "2026-09-21T11:00:00.000Z", edited: true, authorName: "Sam" }
    ]);
    expect(exported.payload.feedReactions).toEqual([{ postId: "post-1", activityId: null, reaction: "well_done", name: "Jo" }]);
  });

  it("restores comments and reactions onto the restored posts and entries, keeping names", async () => {
    mocks.babyCreate.mockResolvedValue({ id: "saved-baby-1", name: "Finley", inactiveAt: null });
    const backup = createV2Backup({
      household: { name: "Recovered Home" },
      settings: {},
      babies: [{
        id: "source-baby-1", name: "Finley", birthDate: null, timezone: "UTC", notes: null,
        feedingWarningMinutes: null, diaperWarningMinutes: null, sleepWarningMinutes: null, preferredUnits: null, inactiveAt: null
      }],
      contacts: [],
      catalogs: [],
      activities: [{
        id: "source-activity-1", babyId: "source-baby-1", type: "milestone",
        occurredAt: "2026-09-20T10:00:00.000Z", startedAt: null, endedAt: null,
        timezone: "UTC", notes: null, source: "manual", externalActorName: null,
        timerState: "none", durationSeconds: null, pausedAt: null, pausedSeconds: 0,
        contactId: null, detail: { title: "First steps" }
      }],
      calendarEvents: [],
      reminders: [],
      feedPosts: [{ id: "source-post-1", babyId: null, body: "Family walk", tags: [], occurredAt: "2026-09-21T10:00:00.000Z", authorName: "Alex" }],
      feedComments: [
        { id: "source-comment-1", postId: "source-post-1", activityId: null, body: "Lovely", createdAt: "2026-09-21T11:00:00.000Z", edited: false, authorName: "Sam" },
        { id: "source-comment-2", postId: null, activityId: "source-activity-1", body: "Go Finley!", createdAt: "2026-09-20T12:00:00.000Z", edited: true, authorName: "Jo" }
      ],
      feedReactions: [{ postId: null, activityId: "source-activity-1", reaction: "celebrate", name: "Alex" }]
    }, "2026-09-27T18:00:00.000Z");

    await expect(restoreBackupJson(backup, { confirmation: "Home", previewChecksum: backup.checksum })).resolves.toMatchObject({
      counts: { feedPosts: 1, feedComments: 2, feedReactions: 1 }
    });
    expect(mocks.feedCommentCreate).toHaveBeenCalledWith({
      data: {
        householdId: "household-1", postId: "saved-Famil", activityId: null, externalAuthorName: "Sam", body: "Lovely",
        createdAt: new Date("2026-09-21T11:00:00.000Z"), editedAt: null
      }
    });
    expect(mocks.feedCommentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ postId: null, activityId: "activity-restored", externalAuthorName: "Jo", editedAt: new Date("2026-09-20T12:00:00.000Z") })
    });
    expect(mocks.feedReactionCreate).toHaveBeenCalledWith({
      data: { householdId: "household-1", postId: null, activityId: "activity-restored", externalReactorName: "Alex", reaction: "celebrate" }
    });
  });

  it("refuses a comment or reaction on a post or entry the backup does not carry", async () => {
    const base = {
      household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: []
    };
    expect(() => createV2Backup({
      ...base,
      feedComments: [{ id: "c-1", postId: "missing", activityId: null, body: "Hi", createdAt: "2026-09-21T11:00:00.000Z", edited: false, authorName: "Sam" }]
    }, "2026-09-27T18:00:00.000Z")).toThrow("backup_dangling_reference");
    expect(() => createV2Backup({
      ...base,
      feedReactions: [{ postId: null, activityId: "missing", reaction: "love", name: "Sam" }]
    }, "2026-09-27T18:00:00.000Z")).toThrow("backup_dangling_reference");
  });

  it("restores a complete v2 snapshot with mapped relationships and one recovery audit", async () => {
    mocks.babyCreate.mockResolvedValue({ id: "saved-baby-1", name: "Finley", inactiveAt: null });
    mocks.babyUpdate.mockResolvedValue({ id: "saved-baby-1", name: "Finley", inactiveAt: new Date("2026-07-14T12:00:00.000Z") });
    const backup = createV2Backup({
      household: { name: "Recovered Home" },
      settings: { accentTheme: "rose", activityOrder: ["sleep", "feeding"] },
      babies: [{
        id: "source-baby-1", name: "Finley", birthDate: null, timezone: "UTC", notes: null,
        feedingWarningMinutes: 120, diaperWarningMinutes: null, sleepWarningMinutes: null,
        preferredUnits: null, inactiveAt: "2026-07-14T12:00:00.000Z"
      }],
      contacts: [{ id: "source-contact-1", name: "Doctor", kind: "pediatrician", phone: null, email: null, address: null, notes: null }],
      catalogs: [{ id: "source-catalog-1", name: "Vitamin D", typicalDoseSize: "1.5", unit: "drops", doseMinTime: null, notes: null, active: true, isSupplement: true }],
      activities: [{
        id: "source-activity-1", babyId: "source-baby-1", type: "sleep",
        occurredAt: "2026-07-14T10:00:00.000Z", startedAt: "2026-07-14T10:00:00.000Z", endedAt: "2026-07-14T11:00:00.000Z",
        timezone: "UTC", notes: "History", source: "sprout", externalActorName: "Grandma",
        timerState: "stopped", durationSeconds: 2700, pausedAt: null, pausedSeconds: 900,
        pauseTrackingStartedAt: "2026-07-14T10:00:00.000Z",
        pauseTrackingBaselineSeconds: 0,
        pauseIntervals: [{ startedAt: "2026-07-14T10:15:00.000Z", endedAt: "2026-07-14T10:30:00.000Z" }],
        contactId: null, detail: { location: "crib" }
      }],
      calendarEvents: [{
        id: "source-event-1", title: "Visit", description: null, startTime: "2026-07-15T18:00:00.000Z",
        endTime: null, allDay: false, eventType: "appointment", location: null, color: null,
        recurring: false, recurrencePattern: null, recurrenceEnd: null, customRecurrence: null,
        reminderMinutes: 30, source: "manual", externalCaretakerNames: [],
        babyIds: ["source-baby-1"], contactIds: ["source-contact-1"]
      }],
      reminders: [{ id: "source-reminder-1", babyId: "source-baby-1", kind: "medicine", title: "Dose", cadenceMinutes: 480, dueAt: null, enabled: true }]
    }, "2026-07-15T18:00:00.000Z");

    await expect(restoreBackupJson(backup, { confirmation: "Home", previewChecksum: backup.checksum })).resolves.toMatchObject({
      restored: 6,
      counts: { babies: 1, contacts: 1, catalogs: 1, activities: 1, calendarEvents: 1, reminders: 1 }
    });

    expect(mocks.householdUpdate).toHaveBeenCalledWith({ where: { id: "household-1" }, data: { name: "Recovered Home" } });
    expect(mocks.restoreActivity).toHaveBeenCalledWith(
      expect.objectContaining({ babyId: "saved-baby-1", type: "sleep" }),
      ctx,
      expect.anything(),
      { timerState: "stopped", durationSeconds: 2700, pausedSeconds: 900 },
      { source: "sprout", externalActorName: "Grandma" },
      {
        startedAt: new Date("2026-07-14T10:00:00.000Z"),
        endedAt: new Date("2026-07-14T11:00:00.000Z"),
        timezone: "UTC",
        pauseTrackingStartedAt: new Date("2026-07-14T10:00:00.000Z"),
        pauseTrackingBaselineSeconds: 0,
        pauseIntervals: [
          {
            startedAt: new Date("2026-07-14T10:15:00.000Z"),
            endedAt: new Date("2026-07-14T10:30:00.000Z")
          }
        ]
      }
    );
    expect(mocks.calendarCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        babies: { create: [{ babyId: "saved-baby-1" }] },
        contacts: { create: [{ contactId: "saved-contact-1" }] }
      })
    }));
    expect(mocks.reminderCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ householdId: "household-1", babyId: "saved-baby-1" })
    }));
    expect(mocks.restoreActivity.mock.invocationCallOrder[0]).toBeLessThan(mocks.babyUpdate.mock.invocationCallOrder[0]);
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "backup.restore" }), expect.anything());
    expect(mocks.backupCreate).toHaveBeenCalledTimes(1);
    expect(mocks.backupCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ itemCount: 6 }) })
    );
  });

  it("exports a complete v2 snapshot from one repeatable-read transaction", async () => {
    mocks.contactFindMany.mockResolvedValue([{ id: "contact-1", name: "Doctor", kind: null, phone: null, email: null, address: null, notes: null }]);
    mocks.catalogFindMany.mockResolvedValue([{ id: "catalog-1", name: "Vitamin D", typicalDoseSize: "1", unit: "drop", doseMinTime: null, notes: null, active: true, isSupplement: true }]);
    mocks.calendarFindMany.mockResolvedValue([{ id: "event-1", title: "Visit", description: null, startTime: new Date("2026-07-15T18:00:00.000Z"), endTime: null, allDay: false, eventType: null, location: null, color: null, recurring: false, recurrencePattern: null, recurrenceEnd: null, customRecurrence: null, reminderMinutes: null, source: "manual", externalCaretakerNames: [], babies: [], contacts: [] }]);
    mocks.reminderFindMany.mockResolvedValue([]);

    const payload = JSON.parse(await exportBackupJson());

    expect(payload).toMatchObject({ format: "cubby-household-backup", version: 2, payload: { household: { name: "Home" } } });
    expect(payload.payload.contacts).toHaveLength(1);
    expect(payload.payload.catalogs).toHaveLength(1);
    expect(payload.payload.calendarEvents).toHaveLength(1);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "RepeatableRead" }));
    expect(mocks.householdFind).toHaveBeenCalledOnce();
    expect(mocks.backupCreate.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.transaction.mock.invocationCallOrder[0]);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ action: "backup.export", entityType: "backup" }),
      expect.anything()
    );
  });

  it.each(["manual", "automated"])("refuses a %s recovery snapshot with unresolved photos on carried posts", async (kind) => {
    mocks.attachmentFindMany.mockImplementation(async ({ where }) => {
      const states = typeof where.state === "string" ? [where.state] : where.state?.in ?? [];
      return states.includes("unavailable") ? [{ id: "unresolved", state: "unavailable", postId: "post-1" }] : [];
    });
    const result = kind === "manual" ? exportBackupForDownload() : exportHouseholdBackupJson("household-1");
    await expect(result).rejects.toThrow("backup_photo_unavailable");
    expect(mocks.attachmentFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ householdId: "household-1", post: { deletedAt: null, OR: [{ babyId: null }, { baby: { deletedAt: null } }] } })
    }));
    expect(mocks.backupCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("builds the same canonical v2 payload for internal and manual export paths", async () => {
    mocks.contactFindMany.mockResolvedValue([{ id: "contact-1", name: "Doctor", kind: null, phone: null, email: null, address: null, notes: null }]);

    const manual = JSON.parse(await exportBackupJson());
    const internal = await exportHouseholdBackupJson("household-1");
    const direct = await buildHouseholdV2Snapshot(
      transactionClient() as unknown as Parameters<typeof buildHouseholdV2Snapshot>[0],
      "household-1",
      internal.exportedAt
    );

    expect(internal).toEqual(direct);
    expect(internal.payload).toEqual(manual.payload);
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "backup.manage");
  });

  it("exports canonical household unit preferences", async () => {
    const payload = JSON.parse(await exportBackupJson());

    expect(payload.payload.settings.unitPreferences).toEqual(unitPreferences);
    expect(payload).not.toHaveProperty("members");
    expect(payload.payload.household).not.toHaveProperty("members");
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "backup.manage");
  });

  it("reports automated backup status from records and local discovery without exposing storage paths", async () => {
    const failureRecord = {
      id: "record-failed",
      createdAt: new Date("2026-07-15T21:30:00.000Z"),
      status: "failed",
      error: "backup_active_timer",
      checksum: null,
      itemCount: null,
      storageFilename: null
    };
    const successRecord = {
      id: "record-success",
      createdAt: new Date("2026-07-14T20:00:00.000Z"),
      status: "complete",
      error: null,
      checksum: "a".repeat(64),
      itemCount: 7,
      storageFilename: "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json"
    };
    mocks.backupFindFirst.mockResolvedValueOnce(successRecord).mockResolvedValueOnce(failureRecord);
    mocks.backupFindMany.mockResolvedValue([successRecord]);
    mocks.scanLocalBackups.mockResolvedValue([
      {
        healthy: true,
        filename: "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json",
        exportedAt: "2026-07-14T20:00:00.000Z",
        householdName: "Recovered Home",
        checksum: "a".repeat(64),
        size: 1234,
        itemCount: 7,
        absolutePath: "C:\\secret\\path.json"
      },
      { healthy: false, filename: "cubby-backup-v2-20260713T200000Z-bbbbbbbbbbbb.json", errorCode: "backup_invalid" }
    ]);

    const status = await getAutomatedBackupStatus();

    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "backup.manage");
    expect(status.config).toEqual({
      enabled: false,
      intervalHours: 24,
      retentionCount: 30,
      pollMinutes: 15,
      retryMinutes: 60
    });
    expect(status.latestSuccess).toEqual({
      createdAt: "2026-07-14T20:00:00.000Z",
      checksum: "a".repeat(64),
      itemCount: 7
    });
    expect(status.latestFailure).toEqual({
      createdAt: "2026-07-15T21:30:00.000Z",
      errorCode: "backup_active_timer"
    });
    expect(status.healthyVersionCount).toBe(1);
    expect(JSON.stringify(status)).not.toContain("C:\\secret\\path.json");
    expect(status.versions).toContainEqual({
      healthy: true,
      filename: "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json",
      exportedAt: "2026-07-14T20:00:00.000Z",
      householdName: "Recovered Home",
      checksum: "a".repeat(64),
      size: 1234,
      itemCount: 7
    });
    expect(mocks.backupFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: "complete", storageFilename: { not: null } })
    }));
    expect(mocks.backupFindMany.mock.calls[0]?.[0]).not.toHaveProperty("take");
    expect(mocks.scanLocalBackups).toHaveBeenCalledWith(
      "/var/lib/cubby/backups",
      ["cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json"]
    );
  });

  it("reports a sanitized warning instead of failing Settings when the backup root is unavailable", async () => {
    mocks.scanLocalBackups.mockRejectedValue(new Error("EACCES C:\\private\\backup-root"));

    const status = await getAutomatedBackupStatus();

    expect(status.healthyVersionCount).toBe(0);
    expect(status.warnings).toEqual([{
      filename: "local backup directory",
      errorCode: "backup_directory_unavailable"
    }]);
    expect(JSON.stringify(status)).not.toContain("private");
  });

  it("reports a linked complete record whose local file is missing", async () => {
    const filename = "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json";
    mocks.backupFindMany.mockResolvedValue([{
      id: "record-success",
      createdAt: new Date("2026-07-14T20:00:00.000Z"),
      status: "complete",
      error: null,
      checksum: "a".repeat(64),
      itemCount: 7,
      storageFilename: filename
    }]);

    const status = await getAutomatedBackupStatus();

    expect(mocks.readLocalBackup).toHaveBeenCalledWith("/var/lib/cubby/backups", filename);
    expect(status.warnings).toContainEqual({ filename, errorCode: "backup_file_missing" });
  });

  it("downloads an existing local backup only through the protected service boundary", async () => {
    mocks.backupFindFirst.mockResolvedValue({
      checksum: "a".repeat(64),
      storageFilename: "backup.json"
    });
    mocks.readLocalBackupDocument.mockResolvedValue({
      file: {
        filename: "backup.json",
        absolutePath: "/private/backup.json",
        checksum: "a".repeat(64)
      },
      body: Buffer.from("backup")
    });

    await expect(downloadLocalBackupFile("backup.json")).resolves.toEqual({
      filename: "backup.json",
      body: Buffer.from("backup")
    });

    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "backup.manage");
    expect(mocks.backupFindFirst).toHaveBeenCalledWith({
      where: {
        householdId: "household-1",
        kind: { in: ["automated_export", "recovery_authorized"] },
        status: "complete",
        storageFilename: "backup.json"
      },
      select: { checksum: true, storageFilename: true }
    });
    expect(mocks.readLocalBackupDocument).toHaveBeenCalledWith("/var/lib/cubby/backups", "backup.json");
    expect(mocks.backupFindFirst.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.readLocalBackupDocument.mock.invocationCallOrder[0]!
    );
  });

  it("hides unassociated recovery files from a fresh sole household and rejects them before file access", async () => {
    const filename = "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json";
    const failedRecord = {
      id: "record-failed",
      createdAt: new Date("2026-07-15T21:30:00.000Z"),
      status: "failed",
      error: "backup_write_failed",
      checksum: null,
      itemCount: null,
      storageFilename: null
    };
    mocks.backupFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(failedRecord).mockResolvedValueOnce(null);
    mocks.backupCount.mockResolvedValue(1);
    mocks.scanLocalBackups.mockResolvedValue([{
      healthy: true,
      filename,
      exportedAt: "2026-07-14T20:00:00.000Z",
      householdName: "Recovered Home",
      checksum: "a".repeat(64),
      size: 100,
      itemCount: 1,
      absolutePath: "/private/recovery.json"
    }]);
    mocks.readLocalBackupDocument.mockResolvedValue({
      file: { filename, absolutePath: "/private/recovery.json", checksum: "a".repeat(64) },
      body: Buffer.from("recovery")
    });

    await expect(getAutomatedBackupStatus()).resolves.toMatchObject({ healthyVersionCount: 0, versions: [] });
    await expect(downloadLocalBackupFile(filename)).rejects.toThrow("not_found");
    expect(mocks.scanLocalBackups).toHaveBeenCalledWith("/var/lib/cubby/backups", []);
    expect(mocks.readLocalBackupDocument).not.toHaveBeenCalled();
  });

  it("does not bootstrap persisted files into an occupied sole household", async () => {
    const filename = "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json";
    mocks.freshState.mockResolvedValue([{ actorIsSoleOwner: true, operationalCount: 1n }]);
    mocks.scanLocalBackups.mockResolvedValue([{
      healthy: true,
      filename,
      exportedAt: "2026-07-14T20:00:00.000Z",
      householdName: "Other Home",
      checksum: "a".repeat(64),
      size: 100,
      absolutePath: "/private/other.json"
    }]);
    mocks.readLocalBackupDocument.mockResolvedValue({
      file: { filename, absolutePath: "/private/other.json", checksum: "a".repeat(64) },
      body: Buffer.from("other")
    });

    await expect(getAutomatedBackupStatus()).resolves.toMatchObject({ healthyVersionCount: 0, versions: [] });
    await expect(downloadLocalBackupFile(filename)).rejects.toThrow("not_found");
  });

  it("hides and rejects another household's persisted backup", async () => {
    const ownFilename = "cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json";
    const otherFilename = "cubby-backup-v2-20260713T200000Z-bbbbbbbbbbbb.json";
    mocks.householdCount.mockResolvedValue(2);
    mocks.backupCount.mockResolvedValue(1);
    mocks.backupFindMany.mockResolvedValue([
      {
        id: "record-success",
        createdAt: new Date("2026-07-14T20:00:00.000Z"),
        status: "complete",
        error: null,
        checksum: "a".repeat(64),
        itemCount: 1,
        storageFilename: ownFilename
      }
    ]);
    mocks.scanLocalBackups.mockResolvedValue([
      {
        healthy: true,
        filename: ownFilename,
        exportedAt: "2026-07-14T20:00:00.000Z",
        householdName: "Home",
        checksum: "a".repeat(64),
        size: 100,
        absolutePath: "/private/own.json"
      },
      {
        healthy: true,
        filename: otherFilename,
        exportedAt: "2026-07-13T20:00:00.000Z",
        householdName: "Other Home",
        checksum: "b".repeat(64),
        size: 100,
        absolutePath: "/private/other.json"
      }
    ]);
    mocks.readLocalBackupDocument.mockResolvedValue({
      file: {
        filename: otherFilename,
        absolutePath: "/private/other.json",
        checksum: "b".repeat(64)
      },
      body: Buffer.from("other")
    });

    const status = await getAutomatedBackupStatus();
    await expect(downloadLocalBackupFile(otherFilename)).rejects.toThrow("not_found");

    expect(status.versions).toHaveLength(1);
    expect(status.versions[0]).toEqual(expect.objectContaining({ filename: ownFilename }));
  });

  it("hands back an archive version by its path, to be streamed rather than read into memory", async () => {
    const filename = "cubby-backup-v2-20260930T100000Z-aaaaaaaaaaaa.zip";
    mocks.isLocalBackupFilename.mockReturnValue(true);
    mocks.backupFindFirst.mockResolvedValue({ checksum: "a".repeat(64), storageFilename: filename });
    mocks.readLocalBackupDocument.mockResolvedValue({
      file: { filename, absolutePath: "/var/lib/cubby/backups/" + filename, checksum: "a".repeat(64), size: 5000 },
      body: null
    });

    await expect(downloadLocalBackupFile(filename)).resolves.toEqual({
      filename, archivePath: "/var/lib/cubby/backups/" + filename, size: 5000
    });
  });

  it("rejects a malformed persisted filename before querying or opening storage", async () => {
    const malformedFilename = "../cubby-backup-v2-20260714T200000Z-aaaaaaaaaaaa.json";
    mocks.isLocalBackupFilename.mockReturnValue(false);
    mocks.backupFindFirst.mockResolvedValue({
      checksum: "a".repeat(64),
      storageFilename: malformedFilename
    });

    await expect(downloadLocalBackupFile(malformedFilename)).rejects.toThrow("not_found");

    expect(mocks.backupFindFirst).not.toHaveBeenCalled();
    expect(mocks.readLocalBackupDocument).not.toHaveBeenCalled();
  });

  it("restores unit preferences without rewriting activities", async () => {
    await expect(restoreBackupJson({
      version: 1,
      settings: { accentTheme: "sage", unitPreferences },
      babies: [],
      activities: []
    })).resolves.toEqual({ restored: 0, counts: { babies: 0, activities: 0 } , members: { restored: 0, needInvite: [] } });

    expect(mocks.settingsUpsert).toHaveBeenCalledWith({
      where: { householdId: "household-1" },
      update: { accentTheme: "sage", unitPreferences },
      create: { householdId: "household-1", accentTheme: "sage", unitPreferences }
    });
    expect(mocks.restoreActivity).not.toHaveBeenCalled();
  });

  it("ignores hostile membership fields without changing membership state", async () => {
    await expect(restoreBackupJson({
      version: 1,
      babies: [],
      activities: [],
      members: [{ id: "member-1", role: "owner", disabledAt: null }],
      household: {
        id: "household-1",
        members: [{ id: "member-1", role: "owner", disabledAt: null }]
      },
      disabledAt: null
    })).resolves.toEqual({ restored: 0, counts: { babies: 0, activities: 0 } , members: { restored: 0, needInvite: [] } });

    expect(mocks.memberCreate).not.toHaveBeenCalled();
    expect(mocks.memberUpdate).not.toHaveBeenCalled();
    expect(mocks.memberUpdateMany).not.toHaveBeenCalled();
    expect(mocks.memberDelete).not.toHaveBeenCalled();
    expect(mocks.memberDeleteMany).not.toHaveBeenCalled();
  });

  it("accepts older v1 backups that do not contain unit preferences", async () => {
    await expect(restoreBackupJson({ version: 1, babies: [], activities: [] })).resolves.toEqual({
      restored: 0,
      counts: { babies: 0, activities: 0 }
    , members: { restored: 0, needInvite: [] } });
    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
  });

  it("restores same-named legacy babies separately and counts babies", async () => {
    mocks.babyCreate
      .mockResolvedValueOnce({ id: "saved-baby-1", name: "Alex", inactiveAt: null })
      .mockResolvedValueOnce({ id: "saved-baby-2", name: "Alex", inactiveAt: null });

    await expect(restoreBackupJson({
      version: 1,
      babies: [
        { id: "source-baby-1", name: "Alex", timezone: "UTC" },
        { id: "source-baby-2", name: "Alex", timezone: "UTC" }
      ],
      activities: [
        { babyId: "source-baby-1", type: "note", occurredAt: "2026-07-14T10:00:00.000Z", text: "First" },
        { babyId: "source-baby-2", type: "note", occurredAt: "2026-07-14T11:00:00.000Z", text: "Second" }
      ]
    })).resolves.toEqual({ restored: 4, counts: { babies: 2, activities: 2 } , members: { restored: 0, needInvite: [] } });

    expect(mocks.babyCreate).toHaveBeenCalledTimes(2);
    expect(mocks.restoreActivity.mock.calls.map(([activity]) => activity.babyId)).toEqual(["saved-baby-1", "saved-baby-2"]);
    expect(mocks.backupCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ itemCount: 4 }) })
    );
  });

  it("drops unavailable contact and attachment relations from legacy activities", async () => {
    mocks.babyCreate.mockResolvedValue({ id: "saved-baby-1", name: "Alex", inactiveAt: null });

    await expect(restoreBackupJson({
      version: 1,
      babies: [{ id: "source-baby-1", name: "Alex", timezone: "UTC" }],
      activities: [{
        babyId: "source-baby-1",
        type: "medicine",
        occurredAt: "2026-07-14T10:00:00.000Z",
        name: "Vitamin D",
        contactId: "legacy-contact",
        documentUrl: "/legacy/private.pdf"
      }]
    })).resolves.toEqual({ restored: 2, counts: { babies: 1, activities: 1 } , members: { restored: 0, needInvite: [] } });

    const restoredInput = mocks.restoreActivity.mock.calls[0][0];
    expect(restoredInput).toMatchObject({ babyId: "saved-baby-1", name: "Vitamin D" });
    expect(restoredInput).not.toHaveProperty("contactId");
    expect(restoredInput).not.toHaveProperty("documentUrl");
  });

  it.each([
    {
      label: "duplicate legacy baby IDs",
      backup: {
        version: 1,
        babies: [
          { id: "source-baby", name: "One", timezone: "UTC" },
          { id: "source-baby", name: "Two", timezone: "UTC" }
        ],
        activities: []
      },
      error: "backup_duplicate_source_id"
    },
    {
      label: "dangling legacy baby reference",
      backup: {
        version: 1,
        babies: [],
        activities: [{ babyId: "foreign-baby", type: "note", occurredAt: "2026-07-14T10:00:00.000Z", text: "Unsafe" }]
      },
      error: "backup_dangling_reference"
    }
  ])("rejects $label before a restore transaction", async ({ backup, error }) => {
    await expect(restoreBackupJson(backup)).rejects.toThrow(error);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("exports baby inactivity timestamps when present", async () => {
    mocks.babyFindMany.mockResolvedValue([
      {
        id: "baby-1",
        name: "Finley",
        birthDate: null,
        timezone: "America/New_York",
        notes: null,
        inactiveAt: new Date("2026-07-14T12:00:00.000Z")
      }
    ]);

    const payload = JSON.parse(await exportBackupJson());

    expect(payload.payload.babies).toEqual([
      expect.objectContaining({
        id: "baby-1",
        inactiveAt: "2026-07-14T12:00:00.000Z"
      })
    ]);
  });

  it("exports stopped timer metadata without losing paused duration", async () => {
    mocks.babyFindMany.mockResolvedValue([{ id: "baby-1", name: "Finley", birthDate: null, timezone: "UTC", notes: null, inactiveAt: null }]);
    mocks.activityFindMany.mockResolvedValue([
      {
        id: "activity-1",
        babyId: "baby-1",
        type: "sleep",
        occurredAt: new Date("2026-07-14T10:00:00.000Z"),
        startedAt: new Date("2026-07-14T10:00:00.000Z"),
        endedAt: new Date("2026-07-14T11:00:00.000Z"),
        durationSeconds: 2700,
        timezone: "UTC",
        notes: null,
        timerState: "stopped",
        pausedAt: null,
        pausedSeconds: 900,
        pauseTrackingStartedAt: new Date("2026-07-14T10:00:00.000Z"),
        pauseTrackingBaselineSeconds: 0,
        pauseIntervals: [
          {
            startedAt: new Date("2026-07-14T10:15:00.000Z"),
            endedAt: new Date("2026-07-14T10:30:00.000Z")
          }
        ],
        sleep: { sleepType: null, location: null, quality: null }
      }
    ]);

    const payload = JSON.parse(await exportBackupJson());

    expect(payload.payload.activities[0]).toEqual(
      expect.objectContaining({
        timerState: "stopped",
        durationSeconds: 2700,
        pausedAt: null,
        pausedSeconds: 900,
        pauseTrackingStartedAt: "2026-07-14T10:00:00.000Z",
        pauseTrackingBaselineSeconds: 0,
        pauseIntervals: [
          {
            startedAt: "2026-07-14T10:15:00.000Z",
            endedAt: "2026-07-14T10:30:00.000Z"
          }
        ]
      })
    );
  });

  it("rejects a stopped timer with an open precise pause instead of rewriting it", async () => {
    mocks.activityFindMany.mockResolvedValue([
      {
        id: "activity-incoherent",
        babyId: "baby-1",
        type: "sleep",
        occurredAt: new Date("2026-07-14T10:00:00.000Z"),
        startedAt: new Date("2026-07-14T10:00:00.000Z"),
        endedAt: new Date("2026-07-14T11:00:00.000Z"),
        durationSeconds: 2700,
        timezone: "UTC",
        notes: null,
        timerState: "stopped",
        pausedAt: null,
        pausedSeconds: 900,
        pauseTrackingStartedAt: new Date("2026-07-14T10:00:00.000Z"),
        pauseIntervals: [{ startedAt: new Date("2026-07-14T10:15:00.000Z"), endedAt: null }],
        sleep: { sleepType: null, location: null, quality: null }
      }
    ]);

    await expect(exportBackupJson()).rejects.toThrow("backup_invalid_pause_intervals");
    expect(mocks.backupCreate).not.toHaveBeenCalled();
  });

  it.each(["running", "paused"])("rejects an exported %s timer without recording success", async (timerState) => {
    mocks.activityFindMany.mockResolvedValue([
      {
        id: "activity-live",
        babyId: "baby-1",
        type: "sleep",
        occurredAt: new Date("2026-07-14T10:00:00.000Z"),
        startedAt: new Date("2026-07-14T10:00:00.000Z"),
        endedAt: null,
        durationSeconds: null,
        timezone: "UTC",
        notes: null,
        timerState,
        pausedAt: timerState === "paused" ? new Date("2026-07-14T10:30:00.000Z") : null,
        pausedSeconds: 0,
        sleep: { sleepType: null, location: null, quality: null }
      }
    ]);

    await expect(exportBackupJson()).rejects.toThrow("backup_active_timer");

    expect(mocks.backupCreate).not.toHaveBeenCalled();
  });

  it.each([
    { label: "timer fields without a state", timer: { pausedSeconds: 1 } },
    {
      label: "partial none metadata",
      timer: { timerState: "none", durationSeconds: 3600, pausedSeconds: 0 }
    },
    {
      label: "contradictory none metadata",
      timer: {
        timerState: "none",
        durationSeconds: 3600,
        pausedAt: "2026-07-14T10:30:00.000Z",
        pausedSeconds: 0
      }
    },
    {
      label: "partial stopped metadata",
      timer: { timerState: "stopped", durationSeconds: 2700, pausedSeconds: 900 }
    },
    {
      label: "incoherent stopped duration",
      timer: { timerState: "stopped", durationSeconds: 2600, pausedAt: null, pausedSeconds: 900 }
    }
  ])("rejects $label before opening a restore transaction", async ({ timer }) => {
    await expect(
      restoreBackupJson({
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "UTC" }],
        activities: [
          {
            babyId: "backup-baby-1",
            type: "sleep",
            occurredAt: "2026-07-14T10:00:00.000Z",
            startedAt: "2026-07-14T10:00:00.000Z",
            endedAt: "2026-07-14T11:00:00.000Z",
            ...timer
          }
        ]
      })
    ).rejects.toThrow("backup_invalid_timer");

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("accepts a complete coherent none timer block from a current export", async () => {
    mocks.babyCreate.mockResolvedValue({ id: "saved-baby-1", name: "Finley", inactiveAt: null });

    await restoreBackupJson({
      version: 1,
      babies: [{ id: "backup-baby-1", name: "Finley", timezone: "UTC" }],
      activities: [
        {
          babyId: "backup-baby-1",
          type: "sleep",
          occurredAt: "2026-07-14T10:00:00.000Z",
          startedAt: "2026-07-14T10:00:00.000Z",
          endedAt: "2026-07-14T11:00:00.000Z",
          timerState: "none",
          durationSeconds: 3600,
          pausedAt: null,
          pausedSeconds: 0
        }
      ]
    });

    expect(mocks.restoreActivity).toHaveBeenCalledWith(expect.anything(), ctx, expect.anything(), undefined);
  });

  it("forwards exact stopped timer metadata to historical restore", async () => {
    mocks.babyCreate.mockResolvedValue({ id: "saved-baby-1", name: "Finley", inactiveAt: null });

    await restoreBackupJson({
      version: 1,
      babies: [{ id: "backup-baby-1", name: "Finley", timezone: "UTC" }],
      activities: [
        {
          babyId: "backup-baby-1",
          type: "sleep",
          occurredAt: "2026-07-14T10:00:00.000Z",
          startedAt: "2026-07-14T10:00:00.000Z",
          endedAt: "2026-07-14T11:00:00.000Z",
          timerState: "stopped",
          durationSeconds: 2700,
          pausedAt: null,
          pausedSeconds: 900
        }
      ]
    });

    expect(mocks.restoreActivity).toHaveBeenCalledWith(
      expect.anything(),
      ctx,
      expect.anything(),
      { timerState: "stopped", durationSeconds: 2700, pausedSeconds: 900 }
    );
  });

  it("restores history and final inactivity in one transaction without temporary reactivation", async () => {
    const createdBaby = {
      id: "saved-baby-1",
      name: "Finley",
      birthDate: null,
      timezone: "America/New_York",
      notes: null,
      inactiveAt: null
    };
    mocks.babyCreate.mockResolvedValue(createdBaby);
    mocks.babyUpdate.mockResolvedValue({ ...createdBaby, inactiveAt: new Date("2026-07-14T12:00:00.000Z") });

    await expect(
      restoreBackupJson({
        version: 1,
        babies: [
          {
            id: "backup-baby-1",
            name: "Finley",
            timezone: "America/New_York",
            inactiveAt: "2026-07-14T12:00:00.000Z"
          }
        ],
        activities: [{ babyId: "backup-baby-1", type: "note", occurredAt: "2026-07-14T11:00:00.000Z", text: "nap note" }]
      })
    ).resolves.toEqual({ restored: 2, counts: { babies: 1, activities: 1 } , members: { restored: 0, needInvite: [] } });

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.restoreActivity).toHaveBeenCalledOnce();
    expect(mocks.restoreActivity.mock.invocationCallOrder[0]).toBeLessThan(mocks.babyUpdate.mock.invocationCallOrder[0]);
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ action: "backup.restore", entityId: "legacy-v1" }),
      expect.anything()
    );
  });

  it("rechecks backup permission with the locked current role before any restore write", async () => {
    mocks.lockActor.mockResolvedValue({ ...ctx, role: "parent" });
    mocks.requirePermission.mockImplementation((candidate, permission) => {
      if (candidate.role === "parent" && permission === "backup.manage") throw new Error("forbidden");
    });

    await expect(restoreBackupJson({ version: 1, babies: [], activities: [] })).rejects.toThrow("forbidden");

    expect(mocks.settingsUpsert).not.toHaveBeenCalled();
    expect(mocks.babyCreate).not.toHaveBeenCalled();
    expect(mocks.backupCreate).not.toHaveBeenCalled();
  });

  it("rejects a restore containing a live timer before opening a transaction", async () => {
    await expect(
      restoreBackupJson({
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "America/New_York" }],
        activities: [
          { babyId: "backup-baby-1", type: "sleep", occurredAt: "2026-07-14T11:00:00.000Z", activeTimer: true }
        ]
      })
    ).rejects.toThrow("backup_active_timer");

    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "inactiveAt",
      backup: {
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "America/New_York", inactiveAt: "not-a-date" }],
        activities: []
      }
    },
    {
      label: "birthDate",
      backup: {
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "America/New_York", birthDate: "not-a-date" }],
        activities: []
      }
    },
    {
      label: "activity occurredAt",
      backup: {
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "America/New_York" }],
        activities: [{ babyId: "backup-baby-1", type: "note", occurredAt: "not-a-date", text: "nap note" }]
      }
    }
  ])("rejects a malformed $label before opening a transaction", async ({ backup }) => {
    await expect(restoreBackupJson(backup)).rejects.toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("propagates activity restore failures and never records completion", async () => {
    mocks.babyCreate.mockResolvedValue({ id: "saved-baby-1", name: "Finley", inactiveAt: null });
    mocks.restoreActivity.mockRejectedValue(new Error("database_unavailable"));

    await expect(
      restoreBackupJson({
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "America/New_York" }],
        activities: [{ babyId: "backup-baby-1", type: "note", occurredAt: "2026-07-14T11:00:00.000Z", text: "nap note" }]
      })
    ).rejects.toThrow("database_unavailable");

    expect(mocks.backupCreate).not.toHaveBeenCalled();
  });

  it("rejects final inactivity when an existing active timer is present", async () => {
    const inactiveAt = new Date("2026-07-14T12:00:00.000Z");
    const existing = { id: "saved-baby-1", name: "Finley", inactiveAt: null };
    mocks.babyCreate.mockResolvedValue(existing);
    mocks.lockBaby.mockResolvedValue(existing);
    mocks.activityFindFirst.mockResolvedValue({ id: "timer-1" });

    await expect(
      restoreBackupJson({
        version: 1,
        babies: [{ id: "backup-baby-1", name: "Finley", timezone: "America/New_York", inactiveAt: inactiveAt.toISOString() }],
        activities: []
      })
    ).rejects.toThrow("baby_has_active_timer");

    expect(mocks.babyUpdate).not.toHaveBeenCalled();
    expect(mocks.backupCreate).not.toHaveBeenCalled();
  });
});

function transactionClient() {
  return {
    $queryRaw: (sql: TemplateStringsArray, ...args: unknown[]) => sql.join("").includes('AS "stagedBytes"')
      ? Promise.resolve([{ stagedBytes: 0n }]) : mocks.freshState(sql, ...args),
    household: { findUniqueOrThrow: mocks.householdFind, update: mocks.householdUpdate },
    householdSettings: { findUnique: mocks.settingsFind, upsert: mocks.settingsUpsert },
    user: { findMany: mocks.userFindMany },
    householdMember: { findUnique: vi.fn(), findFirst: mocks.memberFind, findMany: mocks.memberFindMany, create: mocks.memberCreate },
    session: { findFirst: mocks.sessionFind },
    baby: {
      findMany: mocks.babyFindMany,
      findFirst: mocks.babyFindFirst,
      create: mocks.babyCreate,
      update: mocks.babyUpdate
    },
    activityLog: { findMany: mocks.activityFindMany, findFirst: mocks.activityFindFirst },
    contact: { findMany: mocks.contactFindMany, create: mocks.contactCreate },
    medicineCatalog: { findMany: mocks.catalogFindMany, create: mocks.catalogCreate },
    calendarEvent: { findMany: mocks.calendarFindMany, create: mocks.calendarCreate },
    reminder: { findMany: mocks.reminderFindMany, create: mocks.reminderCreate },
    plannedSchedule: { findMany: mocks.plannedScheduleFindMany, create: mocks.plannedScheduleCreate },
    feedPost: { findMany: mocks.feedPostFindMany, create: mocks.feedPostCreate },
    feedComment: { findMany: mocks.feedCommentFindMany, create: mocks.feedCommentCreate },
    feedReaction: { findMany: mocks.feedReactionFindMany, create: mocks.feedReactionCreate },
    attachment: { findMany: mocks.attachmentFindMany, create: mocks.attachmentCreate },
    backupRecord: { create: mocks.backupCreate }
  };
}

describe("backups with photos", () => {
  const sha = "a".repeat(64);
  const postRow = {
    id: "post-1", babyId: null, body: "", tags: [], occurredAt: new Date("2026-09-29T10:00:00Z"), externalAuthorName: null,
    author: { displayName: "Sam", user: { name: "Sam P" } }
  };
  const photoRow = { id: "ph-1", state: "available", postId: "post-1", position: 0, width: 800, height: 600, byteSize: 4, sha256: sha, storageKey: "1".repeat(32) };
  const listed = { id: "ph-1", postId: "post-1", position: 0, width: 800, height: 600, byteSize: 4, sha256: sha };

  function photoBackup() {
    return createV2Backup({
      household: { name: "Recovered Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: [],
      feedPosts: [{ id: "post-1", babyId: null, body: "", tags: [], occurredAt: "2026-09-29T10:00:00.000Z", authorName: "Sam" }],
      feedPhotos: [listed]
    }, "2026-09-30T10:00:00.000Z");
  }

  function fakeArchive(backup = photoBackup()) {
    return {
      parsed: { version: 2, legacyPartial: false, checksumVerified: true, backup },
      photos: backup.payload.feedPhotos,
      readPhoto: vi.fn(async () => Buffer.from("jpeg")),
      verifyPhotos: vi.fn(async () => 1),
      close: vi.fn(async () => undefined)
    };
  }

  it("lists the shown photos of carried posts, and leaves the list out when there are none", async () => {
    mocks.feedPostFindMany.mockResolvedValue([postRow]);
    mocks.attachmentFindMany.mockResolvedValue([photoRow]);
    const snapshot = await buildHouseholdV2Snapshot(transactionClient() as never, "household-1", "2026-09-30T10:00:00.000Z");

    expect(mocks.attachmentFindMany.mock.calls[0][0].where).toEqual({
      householdId: "household-1", type: "feed_photo", state: { in: ["available", "unavailable"] },
      post: { deletedAt: null, OR: [{ babyId: null }, { baby: { deletedAt: null } }] }
    });
    expect(snapshot.payload.feedPhotos).toEqual([listed]);

    mocks.attachmentFindMany.mockResolvedValue([]);
    const plain = await buildHouseholdV2Snapshot(transactionClient() as never, "household-1", "2026-09-30T10:00:00.000Z");
    // Unchanged for a household without photos, down to its checksum.
    expect(plain.payload).not.toHaveProperty("feedPhotos");
  });

  it("downloads a household without photos as the same JSON file as before", async () => {
    const download = await exportBackupForDownload();
    expect(download.kind).toBe("json");
    expect(download.filename).toMatch(/^cubby-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(JSON.parse((download as { body: string }).body)).toMatchObject({ format: "cubby-household-backup", version: 2 });
  });

  it("rejects legal individual photos whose combined archive exceeds restore capacity before success or byte reads", async () => {
    mocks.feedPostFindMany.mockResolvedValue(Array.from({ length: 100 }, (_, index) => ({ ...postRow, id: `post-${index}` })));
    mocks.attachmentFindMany.mockResolvedValue(Array.from({ length: 100 }, (_, index) => ({
      ...photoRow, id: `photo-${index}`, postId: `post-${index}`, byteSize: 25 * 1024 * 1024
    })));
    await expect(exportBackupForDownload()).rejects.toThrow("archive_too_large");
    await expect(exportHouseholdBackupJson("household-1")).rejects.toThrow("archive_too_large");
    expect(mocks.backupCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
    expect(mocks.readObject).not.toHaveBeenCalled();
  });

  it("does not record success when the JSON-only export cannot carry its photos", async () => {
    mocks.feedPostFindMany.mockResolvedValue([postRow]);
    mocks.attachmentFindMany.mockResolvedValue([photoRow]);
    await expect(exportBackupJson()).rejects.toThrow("backup_photos_missing");
    expect(mocks.backupCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("refuses first-photo verification failure without completed export metadata or audit", async () => {
    mocks.feedPostFindMany.mockResolvedValue([postRow]);
    mocks.attachmentFindMany.mockResolvedValue([photoRow]);
    mocks.readObject.mockRejectedValue(new Error("attachment_store_unavailable"));
    await expect(exportBackupForDownload()).rejects.toThrow("backup_photo_unavailable");
    expect(mocks.backupCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("verifies outside transactions then records preparation, not later stream receipt", async () => {
    mocks.feedPostFindMany.mockResolvedValue([postRow]);
    mocks.attachmentFindMany.mockResolvedValue([photoRow]);
    let active = false;
    mocks.transaction.mockImplementation(async (work) => {
      active = true;
      try { return await work(transactionClient()); } finally { active = false; }
    });
    mocks.readObject.mockImplementationOnce(async () => {
      expect(active).toBe(false);
      expect(mocks.backupCreate).not.toHaveBeenCalled();
      expect(mocks.writeAudit).not.toHaveBeenCalled();
      return Buffer.from("jpeg");
    }).mockRejectedValue(new Error("attachment_store_unavailable"));
    const download = await exportBackupForDownload();
    expect(mocks.lockActor).toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.backupCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: "export", status: "complete" }) });
    if (download.kind !== "archive") throw new Error("expected archive");
    await expect(new Response(download.stream).arrayBuffer()).rejects.toThrow("backup_photo_unavailable");
    expect(mocks.backupCreate).toHaveBeenCalledTimes(1);
    expect(mocks.writeAudit).toHaveBeenCalledTimes(1);
  });

  it("refuses export preparation if authority is revoked after photo verification", async () => {
    mocks.feedPostFindMany.mockResolvedValue([postRow]);
    mocks.attachmentFindMany.mockResolvedValue([photoRow]);
    mocks.readObject.mockImplementation(async () => {
      mocks.lockActor.mockRejectedValue(new Error("forbidden"));
      return Buffer.from("jpeg");
    });
    await expect(exportBackupForDownload()).rejects.toThrow("forbidden");
    expect(mocks.backupCreate).not.toHaveBeenCalled();
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("downloads a household with photos as one archive of the backup and each verified photo", async () => {
    mocks.feedPostFindMany.mockResolvedValue([postRow]);
    mocks.attachmentFindMany.mockResolvedValue([photoRow]);
    mocks.readObject.mockResolvedValue(Buffer.from("jpeg"));

    const download = await exportBackupForDownload();
    expect(download.kind).toBe("archive");
    expect(download.filename).toMatch(/^cubby-backup-\d{4}-\d{2}-\d{2}\.zip$/);
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(os.tmpdir(), "cubby-export-"));
    try {
      const file = path.join(dir, "export.zip");
      await writeFile(file, Buffer.from(await new Response((download as { stream: ReadableStream<Uint8Array> }).stream).arrayBuffer()));
      const zip = await openZipStore(file);
      expect(zip.names()).toEqual(["backup.json", "photos/ph-1.jpg"]);
      expect((await zip.read("photos/ph-1.jpg", 10)).toString()).toBe("jpeg");
      await zip.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(mocks.readObject).toHaveBeenCalledWith(expect.any(String), "1".repeat(32), { byteSize: 4, sha256: sha });
  });

  it("refuses to restore a backup that lists photos from its JSON alone", async () => {
    const backup = photoBackup();
    await expect(previewBackupJson(backup)).rejects.toThrow("backup_photos_missing");
    await expect(restoreBackupJson(backup, { confirmation: "Home", previewChecksum: backup.checksum })).rejects.toThrow("backup_photos_missing");
  });

  it("previews an archive only after checking every photo in it", async () => {
    const archive = fakeArchive();
    mocks.openBackupArchive.mockResolvedValue(archive);
    await expect(previewBackupArchive("/staging/upload.zip")).resolves.toMatchObject({ counts: { feedPosts: 1, feedPhotos: 1 } });
    expect(archive.verifyPhotos).toHaveBeenCalled();
    expect(archive.close).toHaveBeenCalled();
  });

  it("restores an archive, storing each verified photo under a new name on its restored post", async () => {
    const archive = fakeArchive();
    mocks.openBackupArchive.mockResolvedValue(archive);

    mocks.writeObject.mockImplementation(async () => { expect(mocks.intent.create).toHaveBeenCalledTimes(1); });

    await expect(restoreBackupArchive("/staging/upload.zip", { confirmation: "Home", previewChecksum: archive.parsed.backup.checksum }))
      .resolves.toMatchObject({ counts: { feedPosts: 1, feedPhotos: 1 } });

    const [, storageKey, bytes, expected] = mocks.writeObject.mock.calls[0];
    expect(storageKey).toMatch(/^[a-f0-9]{32}$/);
    expect(storageKey).not.toBe(photoRow.storageKey);
    expect([bytes.toString(), expected]).toEqual(["jpeg", { byteSize: 4, sha256: sha }]);
    expect(mocks.attachmentCreate).toHaveBeenCalledWith({
      data: {
        householdId: "household-1", type: "feed_photo", state: "available", storageKey, byteSize: 4, sha256: sha,
        mimeType: "image/jpeg", width: 800, height: 600, postId: "saved-", position: 0, activatedAt: expect.any(Date)
      }
    });
    expect(archive.close).toHaveBeenCalled();
    expect(mocks.removeObject).not.toHaveBeenCalled();
  });

  it("retains owned photos for reconciliation on ambiguous failure, and refuses a stale preview first", async () => {
    const archive = fakeArchive();
    mocks.openBackupArchive.mockResolvedValue(archive);
    await expect(restoreBackupArchive("/staging/upload.zip", { confirmation: "Home", previewChecksum: "0".repeat(64) })).rejects.toThrow("backup_preview_mismatch");
    expect(mocks.writeObject).not.toHaveBeenCalled();

    // A household that is not empty is refused before any photo is stored.
    mocks.freshState.mockResolvedValueOnce([{ actorIsSoleOwner: true, operationalCount: 1n }]);
    await expect(restoreBackupArchive("/staging/upload.zip", { confirmation: "Home", previewChecksum: archive.parsed.backup.checksum }))
      .rejects.toThrow("backup_target_not_empty");
    expect(mocks.writeObject).not.toHaveBeenCalled();

    // A failure inside the restore transaction leaves no stored photo behind.
    mocks.attachmentCreate.mockRejectedValueOnce(new Error("database went away"));
    await expect(restoreBackupArchive("/staging/upload.zip", { confirmation: "Home", previewChecksum: archive.parsed.backup.checksum }))
      .rejects.toThrow("database went away");
    const storageKey = mocks.writeObject.mock.calls[0]?.[1];
    expect(storageKey).toMatch(/^[a-f0-9]{32}$/);
    expect(mocks.intent.create).toHaveBeenCalledTimes(1);
    expect(mocks.removeObject).not.toHaveBeenCalled();
    expect(archive.close).toHaveBeenCalledTimes(3);
  });
});

describe("backup members", () => {
  const rows = [
    {
      role: "owner", displayName: null, joinedAt: new Date("2026-01-02T03:04:05.000Z"), disabledAt: null,
      user: { email: "Owner@Example.com", name: "Owner" }
    },
    {
      role: "parent", displayName: "Dad", joinedAt: new Date("2026-02-03T04:05:06.000Z"), disabledAt: new Date("2026-03-04T05:06:07.000Z"),
      user: { email: "dad@example.com", name: "Dad Smith" }
    }
  ];

  it("carries each member's identity, role and standing, and no credential material", async () => {
    mocks.memberFindMany.mockResolvedValue(rows);

    const snapshot = await buildHouseholdV2Snapshot(transactionClient() as never, "household-1");

    expect(snapshot.payload.members).toEqual([
      { email: "owner@example.com", name: "Owner", role: "owner", displayName: null, joinedAt: "2026-01-02T03:04:05.000Z", disabledAt: null },
      {
        email: "dad@example.com", name: "Dad Smith", role: "parent", displayName: "Dad",
        joinedAt: "2026-02-03T04:05:06.000Z", disabledAt: "2026-03-04T05:06:07.000Z"
      }
    ]);
    // The file must never be able to carry a login, so the query may not even select credentials.
    const selected = JSON.stringify(mocks.memberFindMany.mock.calls[0]?.[0] ?? {});
    expect(selected).not.toMatch(/password|accounts|sessions/i);
  });

  it("leaves out members whose membership was deleted", async () => {
    mocks.memberFindMany.mockResolvedValue([]);

    await buildHouseholdV2Snapshot(transactionClient() as never, "household-1");

    expect(mocks.memberFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { householdId: "household-1", deletedAt: null } }));
  });
});

describe("restoring members", () => {
  const member = {
    email: "dad@example.com", name: "Dad", role: "parent" as const, displayName: "Dad",
    joinedAt: "2026-02-03T04:05:06.000Z", disabledAt: null
  };
  const payloadWith = (members: unknown[]) => createV2Backup({
    household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [],
    activities: [], calendarEvents: [], reminders: [], members
  } as never, "2026-07-15T18:00:00.000Z");

  it("restores a membership for someone who already has an account here", async () => {
    mocks.userFindMany.mockResolvedValue([{ id: "user-dad", email: "dad@example.com" }]);
    const backup = payloadWith([member]);

    const result = await restoreBackupJson(backup, { previewChecksum: backup.checksum });

    expect(mocks.memberCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: "user-dad", role: "parent", displayName: "Dad" })
    }));
    expect(result.members).toEqual({ restored: 1, needInvite: [] });
  });

  it("creates no account for an unknown email, and reports who still needs inviting", async () => {
    mocks.userFindMany.mockResolvedValue([]);
    const backup = payloadWith([member]);

    const result = await restoreBackupJson(backup, { previewChecksum: backup.checksum });

    // The DB owns account creation. A restore must never become a second way accounts are born, so
    // an unknown email must produce no member row at all, not a row attached to an invented user.
    expect(mocks.memberCreate).not.toHaveBeenCalled();
    expect(result.members).toEqual({ restored: 0, needInvite: ["dad@example.com"] });
  });

  it("does not give the restoring owner a second membership from the file", async () => {
    mocks.userFindMany.mockResolvedValue([{ id: "user-1", email: "owner@example.com" }]);
    const backup = payloadWith([{ ...member, email: "owner@example.com", role: "owner" }]);

    const result = await restoreBackupJson(backup, { previewChecksum: backup.checksum });

    expect(mocks.memberCreate).not.toHaveBeenCalled();
    expect(result.members).toEqual({ restored: 0, needInvite: [] });
  });

  it("never restores a membership as owner, so a file cannot hand over the household", async () => {
    mocks.userFindMany.mockResolvedValue([{ id: "user-dad", email: "dad@example.com" }]);
    const backup = payloadWith([{ ...member, role: "owner" }]);

    await restoreBackupJson(backup, { previewChecksum: backup.checksum });

    const role = mocks.memberCreate.mock.calls[0]?.[0]?.data?.role;
    expect(role).toBe("admin");
  });

  it("carries a member's disabled standing rather than silently activating them", async () => {
    mocks.userFindMany.mockResolvedValue([{ id: "user-dad", email: "dad@example.com" }]);
    const backup = payloadWith([{ ...member, disabledAt: "2026-03-04T05:06:07.000Z" }]);

    await restoreBackupJson(backup, { previewChecksum: backup.checksum });

    expect(mocks.memberCreate.mock.calls[0]?.[0]?.data?.disabledAt).toEqual(new Date("2026-03-04T05:06:07.000Z"));
  });
});
