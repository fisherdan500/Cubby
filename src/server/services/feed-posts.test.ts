import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOperationKey } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  issueHousehold: vi.fn(),
  executeHousehold: vi.fn(),
  findMany: vi.fn(),
  writeAudit: vi.fn(),
  claimStagedFeedPhotos: vi.fn(),
  removePostPhotos: vi.fn(),
  restorePostPhotos: vi.fn()
}));

vi.mock("@/server/services/attachments", () => ({
  claimStagedFeedPhotos: mocks.claimStagedFeedPhotos,
  removePostPhotos: mocks.removePostPhotos,
  restorePostPhotos: mocks.restorePostPhotos
}));

vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForHousehold: mocks.getHouseholdContext,
  issueHouseholdBrowserOperation: mocks.issueHousehold,
  executeHouseholdBrowserOperation: mocks.executeHousehold
}));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext, requirePermission: vi.fn() }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { feedPost: { findMany: mocks.findMany } } }));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import {
  issueFeedPostCreateBrowserOperation,
  issueFeedPostDeleteBrowserOperation,
  issueFeedPostRestoreBrowserOperation,
  issueFeedPostUpdateBrowserOperation,
  listFeedPosts,
  listRemovedFeedPosts,
  submitFeedPostCreateBrowserOperation,
  submitFeedPostDeleteBrowserOperation,
  submitFeedPostRestoreBrowserOperation,
  submitFeedPostUpdateBrowserOperation
} from "@/server/services/feed-posts";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const ctx = { userId: "user-1", sessionId: "session-1", householdId: "household-1", memberId: "member-1", role: "caretaker" };

function transaction(options: { baby?: object | null; post?: object | null; photoCount?: number } = {}) {
  return {
    baby: { findFirst: vi.fn().mockResolvedValue(options.baby === undefined ? { id: "baby-1" } : options.baby) },
    feedPost: {
      create: vi.fn().mockResolvedValue({ id: "post-1" }),
      findFirst: vi.fn().mockResolvedValue(options.post ?? null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    attachment: { count: vi.fn().mockResolvedValue(options.photoCount ?? 0) },
    $queryRaw: vi.fn().mockResolvedValue([])
  };
}

const post = (overrides: object = {}) => ({
  id: "post-1", authorMemberId: "member-1", updatedAt: new Date("2026-09-25T10:00:00Z"), deletedAt: null, ...overrides
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getHouseholdContext.mockResolvedValue(ctx);
  mocks.getEffectiveHouseholdContext.mockResolvedValue(ctx);
  mocks.issueHousehold.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
  mocks.findMany.mockResolvedValue([]);
});

describe("feed posts", () => {
  it("lists a baby's posts and the whole family's, never removed ones, and says which this member may remove", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "post-1", authorMemberId: "member-1", author: { displayName: "Sam", user: { name: "Sam P" } }, externalAuthorName: null, editedAt: new Date() },
      { id: "post-2", authorMemberId: "member-2", author: { displayName: null, user: { name: "Alex" } }, externalAuthorName: null, editedAt: null }
    ]);
    const posts = await listFeedPosts({ babyId: "baby-1", tag: "firsts" });
    const where = mocks.findMany.mock.calls[0][0].where;

    expect(where).toMatchObject({ householdId: "household-1", deletedAt: null, OR: [{ babyId: "baby-1" }, { babyId: null }], tags: { has: "firsts" } });
    expect(posts.map((item) => [item.id, item.authorName, item.canRemove, item.canEdit, item.edited])).toEqual([
      ["post-1", "Sam", true, true, true],
      ["post-2", "Alex", false, false, false]
    ]);
  });

  it("lets the author edit their post's caption, re-reading its tags, and refuses one changed meanwhile", async () => {
    await issueFeedPostUpdateBrowserOperation({ operationId, postId: "post-1" });
    const call = mocks.issueHousehold.mock.calls[0][0];
    expect(call).toMatchObject({ operationKey: BrowserOperationKey.feedPostUpdate, targetKind: "post", targetId: "post-1", permission: "feed.post" });
    const snapshot = { kind: "feed-post-update", schemaVersion: 1, postId: "post-1", updatedAt: "2026-09-25T10:00:00.000Z" };
    await expect(call.targetSnapshot(transaction({ post: post() }), ctx)).resolves.toEqual(snapshot);
    // Even a parent, who may remove any post, may not rewrite someone else's.
    await expect(call.targetSnapshot(transaction({ post: post({ authorMemberId: "member-2" }) }), { ...ctx, role: "parent" })).rejects.toThrow("forbidden");

    const tx = transaction({ post: post() });
    mocks.executeHousehold.mockImplementation(async (contract) => {
      await contract.validate(tx, ctx, { targetSnapshot: snapshot });
      return contract.execute(tx, ctx, { targetSnapshot: snapshot });
    });
    await expect(submitFeedPostUpdateBrowserOperation({ operationId, postId: "post-1", body: "First bath #firsts #splash" }))
      .resolves.toEqual({ kind: "feed_post", code: "updated", postId: "post-1" });
    expect(tx.feedPost.updateMany).toHaveBeenCalledWith({
      where: { id: "post-1", householdId: "household-1", deletedAt: null, updatedAt: new Date("2026-09-25T10:00:00.000Z") },
      data: { body: "First bath #firsts #splash", tags: ["firsts", "splash"], editedAt: expect.any(Date) }
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "feed_post.update", after: { tagCount: 2 } }), tx);
    expect(JSON.stringify(mocks.writeAudit.mock.calls)).not.toContain("First bath");

    const changed = transaction({ post: post({ updatedAt: new Date("2026-09-25T11:00:00Z") }) });
    mocks.executeHousehold.mockImplementation((contract) => contract.validate(changed, ctx, { targetSnapshot: snapshot }));
    await expect(submitFeedPostUpdateBrowserOperation({ operationId, postId: "post-1", body: "Again" })).rejects.toThrow("stale_revision");
  });

  it("opens a post for members who may post, binding it to nothing yet", async () => {
    await issueFeedPostCreateBrowserOperation({ operationId });
    expect(mocks.issueHousehold).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: BrowserOperationKey.feedPostCreate, targetKind: "post", permission: "feed.post"
    }));
    expect(mocks.issueHousehold.mock.calls[0][0].targetId).toBeUndefined();
  });

  it("saves a post about a baby of this household, with its tags, and audits only that it was made", async () => {
    const tx = transaction();
    mocks.executeHousehold.mockImplementation((contract) => contract.execute(tx, ctx, { targetSnapshot: {} }));

    await expect(submitFeedPostCreateBrowserOperation({ operationId, body: "First bath! #firsts", babyId: "baby-1" }))
      .resolves.toEqual({ kind: "feed_post", code: "created", postId: "post-1" });
    expect(tx.baby.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "baby-1", householdId: "household-1" }) }));
    expect(tx.feedPost.create).toHaveBeenCalledWith({
      data: { householdId: "household-1", babyId: "baby-1", authorMemberId: "member-1", body: "First bath! #firsts", tags: ["firsts"] },
      select: { id: true }
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "feed_post.create", after: { tagCount: 1 } }), tx);
    expect(JSON.stringify(mocks.writeAudit.mock.calls)).not.toContain("First bath");
  });

  it("saves a whole-family post without a baby, and refuses another household's baby", async () => {
    const tx = transaction({ baby: null });
    mocks.executeHousehold.mockImplementation((contract) => contract.execute(tx, ctx, { targetSnapshot: {} }));

    await submitFeedPostCreateBrowserOperation({ operationId, body: "Family walk", babyId: null });
    expect(tx.feedPost.create.mock.calls[0][0].data.babyId).toBeNull();
    await expect(submitFeedPostCreateBrowserOperation({ operationId, body: "Hello", babyId: "baby-9" })).rejects.toThrow("not_found");
  });

  it("checks the caption before any operation runs", async () => {
    await expect(submitFeedPostCreateBrowserOperation({ operationId, body: "   ", babyId: null })).rejects.toThrow();
    expect(mocks.executeHousehold).not.toHaveBeenCalled();
  });

  it("lets an author remove their own post, bound to that post and its current version", async () => {
    await issueFeedPostDeleteBrowserOperation({ operationId, postId: "post-1" });
    const call = mocks.issueHousehold.mock.calls[0][0];
    expect(call).toMatchObject({ operationKey: BrowserOperationKey.feedPostDelete, targetKind: "post", targetId: "post-1" });

    await expect(call.targetSnapshot(transaction({ post: post() }), ctx)).resolves.toEqual({
      kind: "feed-post-delete", schemaVersion: 1, postId: "post-1", updatedAt: "2026-09-25T10:00:00.000Z"
    });
    // A caretaker may not remove someone else's post.
    await expect(call.targetSnapshot(transaction({ post: post({ authorMemberId: "member-2" }) }), ctx)).rejects.toThrow("forbidden");
    await expect(call.targetSnapshot(transaction({ post: null }), ctx)).rejects.toThrow("not_found");
  });

  it("removes the post it was opened on, and refuses one changed meanwhile", async () => {
    const snapshot = { kind: "feed-post-delete", schemaVersion: 1, postId: "post-1", updatedAt: "2026-09-25T10:00:00.000Z" };
    const tx = transaction({ post: post() });
    mocks.executeHousehold.mockImplementation(async (contract) => {
      await contract.validate(tx, ctx, { targetSnapshot: snapshot });
      return contract.execute(tx, ctx, { targetSnapshot: snapshot });
    });

    await expect(submitFeedPostDeleteBrowserOperation({ operationId, postId: "post-1" })).resolves.toEqual({ kind: "feed_post", code: "deleted", postId: "post-1" });
    expect(tx.feedPost.updateMany).toHaveBeenCalledWith({
      where: { id: "post-1", householdId: "household-1", deletedAt: null, updatedAt: new Date("2026-09-25T10:00:00.000Z") },
      data: { deletedAt: expect.any(Date), deletedByMemberId: "member-1" }
    });
    // Its photos leave with it, into the same thirty-day recovery.
    expect(mocks.removePostPhotos).toHaveBeenCalledWith(tx, ctx, { postId: "post-1", now: expect.any(Date) });

    const changed = transaction({ post: post({ updatedAt: new Date("2026-09-25T11:00:00Z") }) });
    mocks.executeHousehold.mockImplementation((contract) => contract.validate(changed, ctx, { targetSnapshot: snapshot }));
    await expect(submitFeedPostDeleteBrowserOperation({ operationId, postId: "post-1" })).rejects.toThrow("stale_revision");
  });
});

describe("photo posts", () => {
  const photosOn = { enabled: { feed_photo: true } };

  it("refuses photos while they are switched off, before any operation runs", async () => {
    await expect(submitFeedPostCreateBrowserOperation({ operationId, body: "", babyId: null, attachmentIds: ["att-1"] }, { enabled: { feed_photo: false } }))
      .rejects.toThrow("attachment_type_unavailable");
    expect(mocks.executeHousehold).not.toHaveBeenCalled();
  });

  it("shares photos without words, claiming this member's uploads in the post's own transaction", async () => {
    const tx = transaction();
    mocks.executeHousehold.mockImplementation((contract) => contract.execute(tx, ctx, { targetSnapshot: {} }));

    await expect(submitFeedPostCreateBrowserOperation({ operationId, body: "", babyId: "baby-1", attachmentIds: ["att-2", "att-1"] }, photosOn))
      .resolves.toEqual({ kind: "feed_post", code: "created", postId: "post-1" });
    expect(tx.feedPost.create.mock.calls[0][0].data.body).toBe("");
    expect(mocks.claimStagedFeedPhotos).toHaveBeenCalledWith(tx, ctx, { attachmentIds: ["att-2", "att-1"], postId: "post-1" });
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "feed_post.create", after: { tagCount: 0, photoCount: 2 } }), tx);
    // The chosen photos are part of what makes a retry the same request.
    expect(mocks.executeHousehold.mock.calls[0][0].intent).toMatchObject({ attachmentIds: ["att-2", "att-1"] });
  });

  it("keeps a caption optional on edit only for a post that has photos", async () => {
    const snapshot = { kind: "feed-post-update", schemaVersion: 1, postId: "post-1", updatedAt: "2026-09-25T10:00:00.000Z" };
    const run = (tx: ReturnType<typeof transaction>) => mocks.executeHousehold.mockImplementation(async (contract) => {
      await contract.validate(tx, ctx, { targetSnapshot: snapshot });
      return contract.execute(tx, ctx, { targetSnapshot: snapshot });
    });

    run(transaction({ post: post(), photoCount: 0 }));
    await expect(submitFeedPostUpdateBrowserOperation({ operationId, postId: "post-1", body: "  " })).rejects.toThrow("validation_error");

    const withPhotos = transaction({ post: post(), photoCount: 3 });
    run(withPhotos);
    await expect(submitFeedPostUpdateBrowserOperation({ operationId, postId: "post-1", body: "  " })).resolves.toMatchObject({ code: "updated" });
    expect(withPhotos.feedPost.updateMany.mock.calls[0][0].data).toMatchObject({ body: "", tags: [] });
  });

  it("lists each post's shown photos in order, with their shape", async () => {
    await listFeedPosts({ babyId: "baby-1" });
    expect(mocks.findMany.mock.calls[0][0].include.photos).toEqual({
      where: { state: "available" },
      orderBy: { position: "asc" },
      select: { id: true, width: true, height: true }
    });
    expect(mocks.findMany.mock.calls[0][0].where).not.toHaveProperty("photos");
  });

  it("lists only posts with a photo still shown, for the Photos gallery, within the same household and baby", async () => {
    await listFeedPosts({ babyId: "baby-1", withPhotos: true });
    expect(mocks.findMany.mock.calls[0][0].where).toMatchObject({
      householdId: "household-1",
      deletedAt: null,
      OR: [{ babyId: "baby-1" }, { babyId: null }],
      photos: { some: { state: "available" } }
    });
  });
});

describe("bringing a removed post back", () => {
  const removedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const removed = (overrides: object = {}) => post({ deletedAt: removedAt, ...overrides });

  it("opens a restore for a post removed in the last thirty days, by whoever may remove it", async () => {
    await issueFeedPostRestoreBrowserOperation({ operationId, postId: "post-1" });
    const call = mocks.issueHousehold.mock.calls[0][0];
    expect(call).toMatchObject({ operationKey: BrowserOperationKey.feedPostRestore, targetKind: "post", targetId: "post-1", permission: "feed.post" });

    const tx = transaction({ post: removed() });
    await expect(call.targetSnapshot(tx, ctx)).resolves.toEqual({
      kind: "feed-post-restore", schemaVersion: 1, postId: "post-1", deletedAt: removedAt.toISOString()
    });
    expect(tx.feedPost.findFirst.mock.calls[0][0].where).toMatchObject({ id: "post-1", householdId: "household-1", deletedAt: { not: null } });
    await expect(call.targetSnapshot(transaction({ post: removed({ authorMemberId: "member-2" }) }), ctx)).rejects.toThrow("forbidden");
    await expect(call.targetSnapshot(transaction({ post: removed({ deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) }) }), ctx))
      .rejects.toThrow("not_found");
  });

  it("brings back the post and its photos, as removed when opened", async () => {
    const snapshot = { kind: "feed-post-restore", schemaVersion: 1, postId: "post-1", deletedAt: removedAt.toISOString() };
    const tx = transaction({ post: removed() });
    mocks.executeHousehold.mockImplementation(async (contract) => {
      await contract.validate(tx, ctx, { targetSnapshot: snapshot });
      return contract.execute(tx, ctx, { targetSnapshot: snapshot });
    });

    await expect(submitFeedPostRestoreBrowserOperation({ operationId, postId: "post-1" })).resolves.toEqual({ kind: "feed_post", code: "restored", postId: "post-1" });
    expect(tx.feedPost.updateMany).toHaveBeenCalledWith({
      where: { id: "post-1", householdId: "household-1", deletedAt: removedAt },
      data: { deletedAt: null, deletedByMemberId: null }
    });
    expect(mocks.restorePostPhotos).toHaveBeenCalledWith(tx, ctx, { postId: "post-1", now: expect.any(Date) });
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "feed_post.restore", entityId: "post-1" }), tx);
  });

  it("lists recently removed posts: a caretaker their own, a parent everyone's", async () => {
    await listRemovedFeedPosts();
    const where = mocks.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ householdId: "household-1", authorMemberId: "member-1", deletedAt: { gte: expect.any(Date) } });
    expect(Date.now() - where.deletedAt.gte.getTime()).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000 - 1000);

    mocks.getEffectiveHouseholdContext.mockResolvedValue({ ...ctx, role: "parent" });
    await listRemovedFeedPosts();
    expect(mocks.findMany.mock.calls[1][0].where.authorMemberId).toBeUndefined();
  });
});
