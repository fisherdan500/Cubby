import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  processFeedPhoto: vi.fn(),
  writeObject: vi.fn(),
  readObject: vi.fn(),
  removeObject: vi.fn(),
  writeAudit: vi.fn(),
  attachment: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn()
  },
  auditFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext, requirePermission: mocks.requirePermission }));
vi.mock("@/server/services/feed-photo-processing", () => ({ processFeedPhoto: mocks.processFeedPhoto }));
vi.mock("@/server/services/attachment-store", () => ({
  writeAttachmentObject: mocks.writeObject,
  readAttachmentObject: mocks.readObject,
  removeAttachmentObject: mocks.removeObject
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/lib/env", () => ({ attachmentConfig: { directory: "/data/attachments" } }));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    attachment: mocks.attachment,
    auditEvent: { findFirst: mocks.auditFindFirst },
    $queryRaw: mocks.queryRaw,
    $transaction: mocks.transaction
  }
}));

import {
  claimStagedFeedPhotos,
  openAttachment,
  purgeDueAttachments,
  removePostPhotos,
  restorePostPhotos,
  stageFeedPhoto
} from "@/server/services/attachments";

const ctx = { userId: "user-1", householdId: "household-1", memberId: "member-1", role: "caretaker" };
const enabled = { feed_photo: true };
const now = new Date("2026-09-28T12:00:00Z");
const processed = { bytes: Buffer.from("jpeg"), byteSize: 4, sha256: "a".repeat(64), mimeType: "image/jpeg", width: 2560, height: 1920 };
const row = (overrides: object = {}) => ({
  id: "att-1", householdId: "household-1", type: "feed_photo", state: "available", storageKey: "0".repeat(32),
  byteSize: 4, sha256: "a".repeat(64), mimeType: "image/jpeg", ...overrides
});
const tx = () => ({ attachment: mocks.attachment, $queryRaw: mocks.queryRaw });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getEffectiveHouseholdContext.mockResolvedValue(ctx);
  mocks.processFeedPhoto.mockResolvedValue(processed);
  mocks.attachment.create.mockResolvedValue({ id: "att-1" });
  mocks.attachment.updateMany.mockResolvedValue({ count: 1 });
  mocks.transaction.mockImplementation((work) => work(tx()));
  mocks.queryRaw.mockResolvedValue([]);
});

describe("staging a feed photo", () => {
  it("does nothing while feed photos are switched off", async () => {
    await expect(stageFeedPhoto(Buffer.from("x"), { enabled: { feed_photo: false } })).rejects.toThrow("attachment_type_unavailable");
    expect(mocks.processFeedPhoto).not.toHaveBeenCalled();
    expect(mocks.writeObject).not.toHaveBeenCalled();
  });

  it("stores the re-saved photo under a random name, records only what was measured, and audits without content", async () => {
    await expect(stageFeedPhoto(Buffer.from("upload"), { enabled })).resolves.toEqual({ attachmentId: "att-1", width: 2560, height: 1920 });

    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "feed.post");
    const [directory, storageKey, bytes, expected] = mocks.writeObject.mock.calls[0];
    expect([directory, bytes, expected]).toEqual(["/data/attachments", processed.bytes, { byteSize: 4, sha256: "a".repeat(64) }]);
    expect(storageKey).toMatch(/^[a-f0-9]{32}$/);
    expect(mocks.attachment.create).toHaveBeenCalledWith({
      data: {
        householdId: "household-1", type: "feed_photo", storageKey, byteSize: 4, sha256: "a".repeat(64),
        mimeType: "image/jpeg", width: 2560, height: 1920, createdByMemberId: "member-1"
      },
      select: { id: true }
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, { action: "attachment.stage", entityType: "attachment", entityId: "att-1", after: { type: "feed_photo" } }, expect.anything());
  });

  it("records a refused upload by reason only, and keeps nothing of it", async () => {
    mocks.processFeedPhoto.mockRejectedValue(new Error("attachment_unsupported_format"));
    await expect(stageFeedPhoto(Buffer.from("junk"), { enabled })).rejects.toThrow("attachment_unsupported_format");

    expect(mocks.writeObject).not.toHaveBeenCalled();
    expect(mocks.attachment.create).not.toHaveBeenCalled();
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({
      action: "attachment.reject", after: { type: "feed_photo", reason: "unsupported_format" }
    }));
  });

  it("removes the stored bytes again if the record cannot be written", async () => {
    mocks.attachment.create.mockRejectedValue(new Error("database down"));
    await expect(stageFeedPhoto(Buffer.from("upload"), { enabled })).rejects.toThrow();
    expect(mocks.removeObject).toHaveBeenCalledWith("/data/attachments", mocks.writeObject.mock.calls[0][1]);
  });
});

describe("claiming staged photos for a post", () => {
  it("attaches this member's staged photos in the order given", async () => {
    mocks.attachment.findMany.mockResolvedValue([{ id: "att-2" }, { id: "att-1" }]);
    await claimStagedFeedPhotos(tx() as never, ctx as never, { attachmentIds: ["att-2", "att-1"], postId: "post-1", now });

    expect(mocks.attachment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: { in: ["att-2", "att-1"] }, householdId: "household-1", type: "feed_photo", state: "staging",
        createdByMemberId: "member-1", createdAt: { gt: new Date("2026-09-27T12:00:00Z") }
      }
    }));
    expect(mocks.attachment.updateMany.mock.calls.map(([call]) => [call.where.id, call.data.position])).toEqual([["att-2", 0], ["att-1", 1]]);
    expect(mocks.attachment.updateMany.mock.calls[0][0].data).toEqual({ state: "available", postId: "post-1", position: 0, activatedAt: now });
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "attachment.activate", after: { type: "feed_photo", count: 2 } }), expect.anything());
  });

  it("refuses photos it cannot claim: someone else's, already used, repeated, or more than ten", async () => {
    mocks.attachment.findMany.mockResolvedValue([{ id: "att-1" }]);
    await expect(claimStagedFeedPhotos(tx() as never, ctx as never, { attachmentIds: ["att-1", "att-9"], postId: "post-1", now })).rejects.toThrow("not_found");
    await expect(claimStagedFeedPhotos(tx() as never, ctx as never, { attachmentIds: ["att-1", "att-1"], postId: "post-1", now })).rejects.toThrow("attachment_invalid_selection");
    const eleven = Array.from({ length: 11 }, (_, index) => `att-${index}`);
    await expect(claimStagedFeedPhotos(tx() as never, ctx as never, { attachmentIds: eleven, postId: "post-1", now })).rejects.toThrow("attachment_invalid_selection");
    expect(mocks.attachment.updateMany).not.toHaveBeenCalled();
  });
});

describe("opening a photo", () => {
  it("serves verified bytes only to a current member of the household, for a live post", async () => {
    mocks.attachment.findFirst.mockResolvedValue(row());
    mocks.readObject.mockResolvedValue(Buffer.from("jpeg"));

    await expect(openAttachment("att-1", { enabled, now })).resolves.toEqual({ bytes: Buffer.from("jpeg"), mimeType: "image/jpeg" });
    expect(mocks.requirePermission).toHaveBeenCalledWith(ctx, "activity.read");
    expect(mocks.attachment.findFirst.mock.calls[0][0].where).toEqual({
      id: "att-1", householdId: "household-1", state: "available",
      post: { deletedAt: null, OR: [{ babyId: null }, { baby: { deletedAt: null } }] }
    });
    expect(mocks.readObject).toHaveBeenCalledWith("/data/attachments", "0".repeat(32), { byteSize: 4, sha256: "a".repeat(64) });
  });

  it("answers the same for a missing photo, another household's, or a switched-off type", async () => {
    mocks.attachment.findFirst.mockResolvedValue(null);
    await expect(openAttachment("att-1", { enabled, now })).rejects.toThrow("not_found");
    mocks.attachment.findFirst.mockResolvedValue(row());
    await expect(openAttachment("att-1", { now, enabled: { feed_photo: false } })).rejects.toThrow("not_found");
    expect(mocks.readObject).not.toHaveBeenCalled();
  });

  it("stops serving a photo whose bytes went missing or changed, and records that without content", async () => {
    mocks.attachment.findFirst.mockResolvedValue(row());
    mocks.readObject.mockRejectedValue(new Error("attachment_bytes_mismatch"));

    await expect(openAttachment("att-1", { enabled, now })).rejects.toThrow("not_found");
    expect(mocks.attachment.updateMany).toHaveBeenCalledWith({
      where: { id: "att-1", householdId: "household-1", state: "available" },
      data: { state: "unavailable", unavailableAt: now }
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({
      action: "attachment.unavailable", after: { type: "feed_photo", reason: "bytes_mismatch" }
    }), expect.anything());
  });

  it("records a view once a day per member, not on every scroll", async () => {
    mocks.attachment.findFirst.mockResolvedValue(row());
    mocks.readObject.mockResolvedValue(Buffer.from("jpeg"));

    mocks.auditFindFirst.mockResolvedValue(null);
    await openAttachment("att-1", { enabled, now });
    expect(mocks.auditFindFirst.mock.calls[0][0].where).toEqual({
      householdId: "household-1", action: "attachment.view", entityType: "attachment", entityId: "att-1",
      actorMemberId: "member-1", createdAt: { gte: new Date("2026-09-28T00:00:00Z") }
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "attachment.view", after: { type: "feed_photo" } }));

    mocks.writeAudit.mockClear();
    mocks.auditFindFirst.mockResolvedValue({ id: "audit-1" });
    await openAttachment("att-1", { enabled, now });
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });
});

describe("removing and restoring a post's photos", () => {
  it("makes them privately recoverable for thirty days", async () => {
    await removePostPhotos(tx() as never, ctx as never, { postId: "post-1", now });
    expect(mocks.attachment.updateMany).toHaveBeenCalledWith({
      where: { householdId: "household-1", postId: "post-1", state: { in: ["available", "unavailable"] } },
      data: { state: "deleted", deletedAt: now, deletedByMemberId: "member-1", purgeAfter: new Date("2026-10-28T12:00:00Z") }
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "attachment.delete", after: { type: "feed_photo", count: 1 } }), expect.anything());
  });

  it("brings back only photos still inside the window whose bytes are intact", async () => {
    mocks.attachment.findMany.mockResolvedValue([row({ id: "att-1", state: "deleted" }), row({ id: "att-2", state: "deleted" })]);
    mocks.readObject.mockResolvedValueOnce(Buffer.from("jpeg")).mockRejectedValueOnce(new Error("attachment_bytes_missing"));

    await restorePostPhotos(tx() as never, ctx as never, { postId: "post-1", now });

    expect(mocks.attachment.findMany.mock.calls[0][0].where).toEqual({
      householdId: "household-1", postId: "post-1", state: "deleted", purgeAfter: { gt: now }
    });
    expect(mocks.attachment.updateMany.mock.calls.map(([call]) => [call.where.id, call.data.state])).toEqual([["att-1", "available"], ["att-2", "unavailable"]]);
    expect(mocks.attachment.updateMany.mock.calls[0][0].data).toEqual({ state: "available", deletedAt: null, deletedByMemberId: null, purgeAfter: null });
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "attachment.restore", after: { type: "feed_photo", count: 1, unavailableCount: 1 } }), expect.anything());
  });
});

describe("purging", () => {
  it("erases the bytes of expired removals and of uploads nothing claimed, keeping a tombstone", async () => {
    mocks.attachment.findMany.mockResolvedValue([
      row({ id: "att-1", state: "deleted" }),
      row({ id: "att-2", state: "staging", storageKey: "1".repeat(32) })
    ]);
    mocks.attachment.findFirst.mockImplementation(async ({ where }) => row({ id: where.id, state: where.id === "att-1" ? "deleted" : "staging", storageKey: where.id === "att-1" ? "0".repeat(32) : "1".repeat(32) }));

    await expect(purgeDueAttachments(now)).resolves.toEqual({ purged: 2 });

    expect(mocks.attachment.findMany.mock.calls[0][0].where).toEqual({
      OR: [
        { state: "deleted", purgeAfter: { lte: now } },
        { state: "staging", createdAt: { lte: new Date("2026-09-27T12:00:00Z") } }
      ]
    });
    expect(mocks.removeObject.mock.calls).toEqual([["/data/attachments", "0".repeat(32)], ["/data/attachments", "1".repeat(32)]]);
    expect(mocks.attachment.updateMany.mock.calls.map(([call]) => call.data)).toEqual([
      { state: "purged", purgedAt: now }, { state: "purged", purgedAt: now }
    ]);
    expect(mocks.writeAudit.mock.calls.map(([auditCtx, input]) => [auditCtx.userId, input.after])).toEqual([
      [null, { type: "feed_photo", reason: "expired" }],
      [null, { type: "feed_photo", reason: "unclaimed" }]
    ]);
  });

  it("leaves a photo alone if it was restored or claimed after being chosen for purging", async () => {
    mocks.attachment.findMany.mockResolvedValue([row({ id: "att-1", state: "deleted" })]);
    mocks.attachment.findFirst.mockResolvedValue(null);

    await expect(purgeDueAttachments(now)).resolves.toEqual({ purged: 0 });
    expect(mocks.removeObject).not.toHaveBeenCalled();
  });
});
