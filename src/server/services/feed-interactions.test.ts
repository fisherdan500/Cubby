import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOperationKey } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  issueHousehold: vi.fn(),
  executeHousehold: vi.fn(),
  findComments: vi.fn(),
  findReactions: vi.fn(),
  writeAudit: vi.fn()
}));

vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForHousehold: mocks.getHouseholdContext,
  issueHouseholdBrowserOperation: mocks.issueHousehold,
  executeHouseholdBrowserOperation: mocks.executeHousehold
}));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext, requirePermission: vi.fn() }));
vi.mock("@/lib/db/prisma", () => ({
  prisma: { feedComment: { findMany: mocks.findComments }, feedReaction: { findMany: mocks.findReactions } }
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

import {
  issueFeedCommentCreateBrowserOperation,
  issueFeedCommentDeleteBrowserOperation,
  issueFeedCommentUpdateBrowserOperation,
  issueFeedReactionSetBrowserOperation,
  listFeedInteractions,
  submitFeedCommentCreateBrowserOperation,
  submitFeedCommentDeleteBrowserOperation,
  submitFeedCommentUpdateBrowserOperation,
  submitFeedReactionSetBrowserOperation
} from "@/server/services/feed-interactions";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const ctx = { userId: "user-1", sessionId: "session-1", householdId: "household-1", memberId: "member-1", role: "read_only" };
const edited = new Date("2026-09-27T10:00:00Z");

function transaction(options: { post?: object | null; activity?: object | null; comment?: object | null; reaction?: object | null } = {}) {
  return {
    feedPost: { findFirst: vi.fn().mockResolvedValue(options.post === undefined ? { id: "post-1" } : options.post) },
    activityLog: { findFirst: vi.fn().mockResolvedValue(options.activity === undefined ? { id: "activity-1", babyId: "baby-1" } : options.activity) },
    feedComment: {
      create: vi.fn().mockResolvedValue({ id: "comment-1" }),
      findFirst: vi.fn().mockResolvedValue(options.comment ?? null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    feedReaction: {
      findFirst: vi.fn().mockResolvedValue(options.reaction ?? null),
      create: vi.fn().mockResolvedValue({ id: "reaction-1" }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    $queryRaw: vi.fn().mockResolvedValue([])
  };
}

const comment = (overrides: object = {}) => ({ id: "comment-1", authorMemberId: "member-1", updatedAt: edited, ...overrides });
const opened = (kind: "feed-comment-create" | "feed-reaction-set", parentKind: "post" | "activity", parentId: string) =>
  ({ kind, schemaVersion: 1, parentKind, parentId });

function runContract(tx: ReturnType<typeof transaction>, targetSnapshot: object = {}) {
  mocks.executeHousehold.mockImplementation(async (contract) => {
    await contract.validate?.(tx, ctx, { targetSnapshot });
    return contract.execute(tx, ctx, { targetSnapshot });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getHouseholdContext.mockResolvedValue(ctx);
  mocks.getEffectiveHouseholdContext.mockResolvedValue(ctx);
  mocks.issueHousehold.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
  mocks.findComments.mockResolvedValue([]);
  mocks.findReactions.mockResolvedValue([]);
});

describe("reading comments and reactions", () => {
  it("gathers the live comments and the reactions for the posts and entries shown, keyed by what they are on", async () => {
    mocks.findComments.mockResolvedValue([
      {
        id: "comment-1", postId: "post-1", activityId: null, authorMemberId: "member-1", externalAuthorName: null,
        author: { displayName: "Sam", user: { name: "Sam P" } }, body: "So sweet", createdAt: edited, editedAt: null
      },
      {
        id: "comment-2", postId: null, activityId: "activity-1", authorMemberId: "member-2", externalAuthorName: null,
        author: { displayName: null, user: { name: "Alex" } }, body: "Big one!", createdAt: edited, editedAt: edited
      }
    ]);
    mocks.findReactions.mockResolvedValue([
      { postId: "post-1", activityId: null, memberId: "member-2", externalReactorName: null, reaction: "love", member: { displayName: "Alex", user: { name: "Alex" } } },
      { postId: "post-1", activityId: null, memberId: "member-1", externalReactorName: null, reaction: "love", member: { displayName: "Sam", user: { name: "Sam P" } } }
    ]);

    const result = await listFeedInteractions({ postIds: ["post-1"], activityIds: ["activity-1"] });

    const where = mocks.findComments.mock.calls[0][0].where;
    expect(where).toEqual({ householdId: "household-1", deletedAt: null, OR: [{ postId: { in: ["post-1"] } }, { activityId: { in: ["activity-1"] } }] });
    expect(result.comments["post:post-1"]).toEqual([
      { id: "comment-1", body: "So sweet", authorName: "Sam", createdAt: edited, edited: false, canEdit: true, canRemove: true }
    ]);
    // A read-only member may neither edit nor remove someone else's comment.
    expect(result.comments["activity:activity-1"]).toEqual([
      { id: "comment-2", body: "Big one!", authorName: "Alex", createdAt: edited, edited: true, canEdit: false, canRemove: false }
    ]);
    expect(result.reactions["post:post-1"]).toEqual([{ key: "love", emoji: "❤️", label: "love", names: ["You", "Alex"], mine: true }]);
    expect(result.reactions["activity:activity-1"]).toBeUndefined();
    expect(result.canRespond).toBe(true);
  });

  it("asks nothing of the database when nothing is shown", async () => {
    await expect(listFeedInteractions({ postIds: [], activityIds: [] })).resolves.toMatchObject({ comments: {}, reactions: {} });
    expect(mocks.findComments).not.toHaveBeenCalled();
    expect(mocks.findReactions).not.toHaveBeenCalled();
  });
});

describe("commenting", () => {
  it("opens a comment bound to the post or entry it is on, for any member", async () => {
    await issueFeedCommentCreateBrowserOperation({ operationId, parentKind: "activity", parentId: "activity-1" });
    const call = mocks.issueHousehold.mock.calls[0][0];
    expect(call).toMatchObject({ operationKey: BrowserOperationKey.feedCommentCreate, targetKind: "activity", targetId: "activity-1", permission: "feed.comment" });

    await expect(call.targetSnapshot(transaction(), ctx)).resolves.toEqual({
      kind: "feed-comment-create", schemaVersion: 1, parentKind: "activity", parentId: "activity-1"
    });
    await expect(call.targetSnapshot(transaction({ activity: null }), ctx)).rejects.toThrow("not_found");
  });

  it("saves a comment on a live post of this household, and audits only what it was on", async () => {
    const tx = transaction();
    runContract(tx, opened("feed-comment-create", "post", "post-1"));

    await expect(submitFeedCommentCreateBrowserOperation({ operationId, parentKind: "post", parentId: "post-1", body: " So sweet " }))
      .resolves.toEqual({ kind: "feed_comment", code: "created", commentId: "comment-1" });
    expect(tx.feedPost.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "post-1", householdId: "household-1", deletedAt: null } }));
    expect(tx.feedComment.create).toHaveBeenCalledWith({
      data: { householdId: "household-1", postId: "post-1", activityId: null, authorMemberId: "member-1", body: "So sweet" },
      select: { id: true }
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "feed_comment.create", after: { parentKind: "post" } }), tx);
    expect(JSON.stringify(mocks.writeAudit.mock.calls)).not.toContain("So sweet");
  });

  it("comments on a logged entry without changing the entry", async () => {
    const tx = transaction();
    runContract(tx, opened("feed-comment-create", "activity", "activity-1"));

    await submitFeedCommentCreateBrowserOperation({ operationId, parentKind: "activity", parentId: "activity-1", body: "Big one!" });
    expect(tx.activityLog.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "activity-1", householdId: "household-1", deletedAt: null, baby: { deletedAt: null } }
    }));
    expect(tx.feedComment.create.mock.calls[0][0].data).toMatchObject({ postId: null, activityId: "activity-1" });
    expect(Object.keys(tx.activityLog)).toEqual(["findFirst"]);
  });

  it("refuses a comment on a removed post or on another post than it was opened for, and checks the text before any operation runs", async () => {
    runContract(transaction({ post: null }), opened("feed-comment-create", "post", "post-1"));
    await expect(submitFeedCommentCreateBrowserOperation({ operationId, parentKind: "post", parentId: "post-1", body: "Hi" })).rejects.toThrow("not_found");
    runContract(transaction(), opened("feed-comment-create", "post", "post-2"));
    await expect(submitFeedCommentCreateBrowserOperation({ operationId, parentKind: "post", parentId: "post-1", body: "Hi" })).rejects.toThrow("not_found");

    mocks.executeHousehold.mockReset();
    await expect(submitFeedCommentCreateBrowserOperation({ operationId, parentKind: "post", parentId: "post-1", body: "  " })).rejects.toThrow();
    expect(mocks.executeHousehold).not.toHaveBeenCalled();
  });

  it("lets the author edit their comment, marked as edited, and refuses one changed meanwhile", async () => {
    await issueFeedCommentUpdateBrowserOperation({ operationId, commentId: "comment-1" });
    const call = mocks.issueHousehold.mock.calls[0][0];
    expect(call).toMatchObject({ operationKey: BrowserOperationKey.feedCommentUpdate, targetKind: "comment", targetId: "comment-1", permission: "feed.comment" });
    const snapshot = { kind: "feed-comment-update", schemaVersion: 1, commentId: "comment-1", updatedAt: edited.toISOString() };
    await expect(call.targetSnapshot(transaction({ comment: comment() }), ctx)).resolves.toEqual(snapshot);
    await expect(call.targetSnapshot(transaction({ comment: comment({ authorMemberId: "member-2" }) }), ctx)).rejects.toThrow("forbidden");

    const tx = transaction({ comment: comment() });
    runContract(tx, snapshot);
    await expect(submitFeedCommentUpdateBrowserOperation({ operationId, commentId: "comment-1", body: "Edited words" }))
      .resolves.toEqual({ kind: "feed_comment", code: "updated", commentId: "comment-1" });
    expect(tx.feedComment.updateMany).toHaveBeenCalledWith({
      where: { id: "comment-1", householdId: "household-1", deletedAt: null, updatedAt: edited },
      data: { body: "Edited words", editedAt: expect.any(Date) }
    });
    expect(JSON.stringify(mocks.writeAudit.mock.calls)).not.toContain("Edited words");

    runContract(transaction({ comment: comment({ updatedAt: new Date("2026-09-27T11:00:00Z") }) }), snapshot);
    await expect(submitFeedCommentUpdateBrowserOperation({ operationId, commentId: "comment-1", body: "Again" })).rejects.toThrow("stale_revision");
  });

  it("lets the author or a parent remove a comment, but not another read-only member", async () => {
    await issueFeedCommentDeleteBrowserOperation({ operationId, commentId: "comment-1" });
    const call = mocks.issueHousehold.mock.calls[0][0];
    expect(call).toMatchObject({ operationKey: BrowserOperationKey.feedCommentDelete, targetKind: "comment", targetId: "comment-1" });
    await expect(call.targetSnapshot(transaction({ comment: comment({ authorMemberId: "member-2" }) }), ctx)).rejects.toThrow("forbidden");
    await expect(call.targetSnapshot(transaction({ comment: comment({ authorMemberId: "member-2" }) }), { ...ctx, role: "parent" }))
      .resolves.toMatchObject({ kind: "feed-comment-delete", commentId: "comment-1" });

    const snapshot = { kind: "feed-comment-delete", schemaVersion: 1, commentId: "comment-1", updatedAt: edited.toISOString() };
    const tx = transaction({ comment: comment() });
    runContract(tx, snapshot);
    await expect(submitFeedCommentDeleteBrowserOperation({ operationId, commentId: "comment-1" }))
      .resolves.toEqual({ kind: "feed_comment", code: "deleted", commentId: "comment-1" });
    expect(tx.feedComment.updateMany).toHaveBeenCalledWith({
      where: { id: "comment-1", householdId: "household-1", deletedAt: null, updatedAt: edited },
      data: { deletedAt: expect.any(Date), deletedByMemberId: "member-1" }
    });
  });
});

describe("reacting", () => {
  it("opens a reaction bound to the post or entry it is on", async () => {
    await issueFeedReactionSetBrowserOperation({ operationId, parentKind: "post", parentId: "post-1" });
    const call = mocks.issueHousehold.mock.calls[0][0];
    expect(call).toMatchObject({ operationKey: BrowserOperationKey.feedReactionSet, targetKind: "post", targetId: "post-1", permission: "feed.comment" });
    await expect(call.targetSnapshot(transaction(), ctx)).resolves.toEqual({
      kind: "feed-reaction-set", schemaVersion: 1, parentKind: "post", parentId: "post-1"
    });
  });

  it("turns a reaction on once, however often the same request arrives", async () => {
    const tx = transaction();
    runContract(tx, opened("feed-reaction-set", "post", "post-1"));
    await expect(submitFeedReactionSetBrowserOperation({ operationId, parentKind: "post", parentId: "post-1", reaction: "aww", on: true }))
      .resolves.toEqual({ kind: "feed_reaction", code: "set", reaction: "aww", on: true });
    expect(tx.feedReaction.create).toHaveBeenCalledWith({
      data: { householdId: "household-1", postId: "post-1", activityId: null, memberId: "member-1", reaction: "aww" },
      select: { id: true }
    });
    expect(mocks.writeAudit).toHaveBeenCalledWith(ctx, expect.objectContaining({ action: "feed_reaction.set", after: { reaction: "aww", on: true } }), tx);

    const already = transaction({ reaction: { id: "reaction-1" } });
    runContract(already, opened("feed-reaction-set", "post", "post-1"));
    await submitFeedReactionSetBrowserOperation({ operationId, parentKind: "post", parentId: "post-1", reaction: "aww", on: true });
    expect(already.feedReaction.create).not.toHaveBeenCalled();
  });

  it("turns a reaction off by removing only this member's one", async () => {
    const tx = transaction();
    runContract(tx, opened("feed-reaction-set", "activity", "activity-1"));
    await submitFeedReactionSetBrowserOperation({ operationId, parentKind: "activity", parentId: "activity-1", reaction: "well_done", on: false });
    expect(tx.feedReaction.deleteMany).toHaveBeenCalledWith({
      where: { householdId: "household-1", postId: null, activityId: "activity-1", memberId: "member-1", reaction: "well_done" }
    });
  });

  it("refuses a reaction outside the offered five before any operation runs", async () => {
    await expect(submitFeedReactionSetBrowserOperation({ operationId, parentKind: "post", parentId: "post-1", reaction: "angry", on: true })).rejects.toThrow();
    expect(mocks.executeHousehold).not.toHaveBeenCalled();
  });
});
