import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserOperationKey } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  getHouseholdContext: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  issueHousehold: vi.fn(),
  executeHousehold: vi.fn(),
  findMany: vi.fn(),
  writeAudit: vi.fn()
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
  listFeedPosts,
  submitFeedPostCreateBrowserOperation,
  submitFeedPostDeleteBrowserOperation
} from "@/server/services/feed-posts";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const ctx = { userId: "user-1", sessionId: "session-1", householdId: "household-1", memberId: "member-1", role: "caretaker" };

function transaction(options: { baby?: object | null; post?: object | null } = {}) {
  return {
    baby: { findFirst: vi.fn().mockResolvedValue(options.baby === undefined ? { id: "baby-1" } : options.baby) },
    feedPost: {
      create: vi.fn().mockResolvedValue({ id: "post-1" }),
      findFirst: vi.fn().mockResolvedValue(options.post ?? null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
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
      { id: "post-1", authorMemberId: "member-1", author: { displayName: "Sam", user: { name: "Sam P" } }, externalAuthorName: null },
      { id: "post-2", authorMemberId: "member-2", author: { displayName: null, user: { name: "Alex" } }, externalAuthorName: null }
    ]);
    const posts = await listFeedPosts({ babyId: "baby-1", tag: "firsts" });
    const where = mocks.findMany.mock.calls[0][0].where;

    expect(where).toMatchObject({ householdId: "household-1", deletedAt: null, OR: [{ babyId: "baby-1" }, { babyId: null }], tags: { has: "firsts" } });
    expect(posts.map((item) => [item.id, item.authorName, item.canRemove])).toEqual([["post-1", "Sam", true], ["post-2", "Alex", false]]);
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

    const changed = transaction({ post: post({ updatedAt: new Date("2026-09-25T11:00:00Z") }) });
    mocks.executeHousehold.mockImplementation((contract) => contract.validate(changed, ctx, { targetSnapshot: snapshot }));
    await expect(submitFeedPostDeleteBrowserOperation({ operationId, postId: "post-1" })).rejects.toThrow("stale_revision");
  });
});
