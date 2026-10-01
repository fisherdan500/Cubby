/**
 * A photo post can only belong to an entry in the caller's own household.
 *
 * The link is a composite foreign key through householdId, so the database refuses a cross-household
 * link outright. This proves the service refuses it first, with a clear outcome rather than a
 * constraint violation, and that it re-checks inside the write transaction against the locked
 * household rather than trusting the request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeHousehold: vi.fn(),
  getContext: vi.fn(),
  writeAudit: vi.fn(),
  claimStagedFeedPhotos: vi.fn(),
  attachmentTypeEnabled: vi.fn(() => true)
}));

vi.mock("@/server/services/browser-operations", () => ({
  executeHouseholdBrowserOperation: mocks.executeHousehold,
  getBrowserOperationContextForHousehold: mocks.getContext,
  issueHouseholdBrowserOperation: vi.fn(),
  BrowserOperationKey: { feedPostCreate: "feed_post.create" }
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/server/services/attachments", () => ({
  claimStagedFeedPhotos: mocks.claimStagedFeedPhotos,
  removePostPhotos: vi.fn(),
  restorePostPhotos: vi.fn()
}));
vi.mock("@/domain/attachments", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/domain/attachments");
  return { ...actual, attachmentTypeEnabled: mocks.attachmentTypeEnabled };
});

const ctx = { householdId: "household-1", memberId: "member-1", userId: "user-1", role: "parent" as const, permissions: [], sessionId: "s-1" };

function transaction(activityFound: unknown) {
  return {
    baby: { findFirst: vi.fn(async () => ({ id: "baby-1" })) },
    activityLog: { findFirst: vi.fn(async () => activityFound) },
    feedPost: { create: vi.fn(async () => ({ id: "post-1" })) }
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === "function") (m as ReturnType<typeof vi.fn>).mockReset?.();
  mocks.attachmentTypeEnabled.mockReturnValue(true);
  mocks.getContext.mockResolvedValue(ctx);
});

describe("linking a photo post to a logged entry", () => {
  it("looks the entry up in the locked household, not the one the request claims", async () => {
    const tx = transaction({ id: "act-1", actorMemberId: "member-1" });
    mocks.executeHousehold.mockImplementation((contract: { execute: Function }) => contract.execute(tx, ctx, { targetSnapshot: {} }));
    const { submitFeedPostCreateBrowserOperation } = await import("@/server/services/feed-posts");

    await submitFeedPostCreateBrowserOperation({ operationId: "op-1", body: "Bath time", activityId: "act-1" });

    expect(tx.activityLog.findFirst).toHaveBeenCalledWith({
      where: { id: "act-1", householdId: "household-1", deletedAt: null },
      // Who logged it is read too, because adding a photo needs the authority to change the entry.
      select: { id: true, actorMemberId: true }
    });
  });

  it("refuses an entry that is not in this household", async () => {
    // findFirst returns nothing because the household does not match.
    const tx = transaction(null);
    mocks.executeHousehold.mockImplementation((contract: { execute: Function }) => contract.execute(tx, ctx, { targetSnapshot: {} }));
    const { submitFeedPostCreateBrowserOperation } = await import("@/server/services/feed-posts");

    await expect(
      submitFeedPostCreateBrowserOperation({ operationId: "op-1", body: "Bath time", activityId: "someone-elses-activity" })
    ).rejects.toThrow("not_found");
    expect(tx.feedPost.create).not.toHaveBeenCalled();
  });

  it("refuses an entry that was deleted while the request was in flight", async () => {
    const tx = transaction(null);
    mocks.executeHousehold.mockImplementation((contract: { execute: Function }) => contract.execute(tx, ctx, { targetSnapshot: {} }));
    const { submitFeedPostCreateBrowserOperation } = await import("@/server/services/feed-posts");

    await expect(
      submitFeedPostCreateBrowserOperation({ operationId: "op-1", body: "Bath time", activityId: "act-gone" })
    ).rejects.toThrow("not_found");
  });

  it("stores the link when the entry is this household's", async () => {
    const tx = transaction({ id: "act-1", actorMemberId: "member-1" });
    mocks.executeHousehold.mockImplementation((contract: { execute: Function }) => contract.execute(tx, ctx, { targetSnapshot: {} }));
    const { submitFeedPostCreateBrowserOperation } = await import("@/server/services/feed-posts");

    await submitFeedPostCreateBrowserOperation({ operationId: "op-1", body: "Bath time", activityId: "act-1" });

    expect(tx.feedPost.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ activityId: "act-1" }) })
    );
  });

  it("does not look up any entry for an ordinary post", async () => {
    const tx = transaction({ id: "act-1", actorMemberId: "member-1" });
    mocks.executeHousehold.mockImplementation((contract: { execute: Function }) => contract.execute(tx, ctx, { targetSnapshot: {} }));
    const { submitFeedPostCreateBrowserOperation } = await import("@/server/services/feed-posts");

    await submitFeedPostCreateBrowserOperation({ operationId: "op-1", body: "Just a thought" });

    expect(tx.activityLog.findFirst).not.toHaveBeenCalled();
    expect(tx.feedPost.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ activityId: null }) })
    );
  });
});

describe("who may add a photo to an entry", () => {
  it("refuses a member who may not change that entry", async () => {
    // The entry screen hides the control unless you may change the entry. The server must agree, or
    // the screen promises a restriction that does not exist.
    const tx = transaction({ id: "act-1", actorMemberId: "someone-else" });
    mocks.executeHousehold.mockImplementation((contract: { execute: Function }) =>
      contract.execute(tx, { ...ctx, role: "caretaker" }, { targetSnapshot: {} }));
    const { submitFeedPostCreateBrowserOperation } = await import("@/server/services/feed-posts");

    await expect(
      submitFeedPostCreateBrowserOperation({ operationId: "op-1", body: "", activityId: "act-1", attachmentIds: ["att-1"] })
    ).rejects.toThrow("forbidden");
    expect(tx.feedPost.create).not.toHaveBeenCalled();
  });

  it("allows a member adding a photo to an entry they logged themselves", async () => {
    const tx = transaction({ id: "act-1", actorMemberId: "member-1" });
    mocks.executeHousehold.mockImplementation((contract: { execute: Function }) =>
      contract.execute(tx, { ...ctx, role: "caretaker" }, { targetSnapshot: {} }));
    const { submitFeedPostCreateBrowserOperation } = await import("@/server/services/feed-posts");

    await submitFeedPostCreateBrowserOperation({ operationId: "op-1", body: "", activityId: "act-1", attachmentIds: ["att-1"] });

    expect(tx.feedPost.create).toHaveBeenCalled();
  });

  it("allows a parent to add a photo to any entry in the household", async () => {
    const tx = transaction({ id: "act-1", actorMemberId: "someone-else" });
    mocks.executeHousehold.mockImplementation((contract: { execute: Function }) =>
      contract.execute(tx, { ...ctx, role: "parent" }, { targetSnapshot: {} }));
    const { submitFeedPostCreateBrowserOperation } = await import("@/server/services/feed-posts");

    await submitFeedPostCreateBrowserOperation({ operationId: "op-1", body: "", activityId: "act-1", attachmentIds: ["att-1"] });

    expect(tx.feedPost.create).toHaveBeenCalled();
  });

  it("leaves an ordinary post unaffected by entry authority", async () => {
    const tx = transaction(null);
    mocks.executeHousehold.mockImplementation((contract: { execute: Function }) =>
      contract.execute(tx, { ...ctx, role: "caretaker" }, { targetSnapshot: {} }));
    const { submitFeedPostCreateBrowserOperation } = await import("@/server/services/feed-posts");

    await submitFeedPostCreateBrowserOperation({ operationId: "op-1", body: "Just a thought" });

    expect(tx.feedPost.create).toHaveBeenCalled();
  });
});
