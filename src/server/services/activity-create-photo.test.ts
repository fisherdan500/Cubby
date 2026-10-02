/**
 * Attaching a photo while logging an entry.
 *
 * The photo is chosen before the entry exists, so it is uploaded privately first and then attached by
 * the same save that creates the entry. That order is what makes the promise keepable: the entry and
 * its picture become visible together or neither does, and a save that fails leaves no half-logged
 * entry and no post pointing at nothing.
 *
 * The photo itself stays an ordinary feed photo on a real post, which is what keeps private delivery
 * and backups working, exactly as a photo added to an already-saved entry does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// This suite imports the service graph inside test bodies -- deliberately, so the vi.mock factories
// and the audit guard below install first -- so a cold transform can outlast vitest's 5s default on an
// otherwise fast test. Scoped here rather than relaxing every suite in the repo.
vi.setConfig({ testTimeout: 20_000 });

const mocks = vi.hoisted(() => ({
  executeBrowserOperation: vi.fn(),
  getContextForBaby: vi.fn(),
  claimStagedFeedPhotos: vi.fn(),
  writeAudit: vi.fn(),
  queueActivitySideEffects: vi.fn()
}));

// The audit trail must not reach a real database here, but it still has a contract: each action's
// payload is minimized against a strict schema. Stubbing that away once let a malformed payload reach
// a frozen candidate, so the stub below keeps the validation and drops only the write.
vi.mock("@/server/services/audit", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/server/services/audit");
  return { ...actual, writeAudit: mocks.writeAudit };
});

vi.mock("@/server/services/browser-operations", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/server/services/browser-operations");
  return {
    ...actual,
    executeBrowserOperation: mocks.executeBrowserOperation,
    getBrowserOperationContextForBaby: mocks.getContextForBaby
  };
});
vi.mock("@/server/services/attachments", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/server/services/attachments");
  return { ...actual, claimStagedFeedPhotos: mocks.claimStagedFeedPhotos };
});

const ctx = {
  householdId: "house-1",
  memberId: "member-1",
  userId: "user-1",
  role: "parent" as const,
  permissions: [],
  sessionId: "s-1"
};

const baby = { id: "baby-1", inactiveAt: null, updatedAt: new Date("2026-10-01T00:00:00.000Z") };

/** A transaction that records what the save wrote, in order. */
function transaction(calls: string[]) {
  return {
    activityLog: {
      create: vi.fn(async (args: { data?: { occurredAt?: Date } }) => {
        calls.push("activity");
        // Mirrors the row the database would return, so the photo post can be dated from it.
        return {
          id: "act-new",
          babyId: "baby-1",
          householdId: "house-1",
          occurredAt: args?.data?.occurredAt ?? new Date("2026-10-01T08:00:00.000Z")
        };
      })
    },
    feedPost: {
      create: vi.fn(async () => {
        calls.push("post");
        return { id: "post-new" };
      })
    },
    // Webhook and notification fan-out is its own concern with its own tests; here nothing is
    // configured, which is the ordinary case for this household.
    webhookEndpoint: { findMany: vi.fn(async () => []) },
    webhookDelivery: { createMany: vi.fn(async () => ({ count: 0 })) },
    notificationPreference: { findMany: vi.fn(async () => []) },
    notificationLog: { createMany: vi.fn(async () => ({ count: 0 })) },
    contact: { findFirst: vi.fn(async () => null) },
    $queryRaw: vi.fn(async () => [])
  };
}

function entry(extra: Record<string, unknown> = {}) {
  return {
    operationId: "11111111-1111-4111-8111-111111111111",
    babyId: "baby-1",
    type: "feeding",
    mode: "bottle",
    amount: null,
    leftSeconds: null,
    rightSeconds: null,
    occurredAt: "2026-10-01T08:00:00.000Z",
    timezone: "Etc/UTC",
    ...extra
  };
}

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  // The audit layer minimizes each action's payload against a strict schema. A stub that accepts
  // anything hides a malformed write until it fails against the real database and takes the family's
  // entry down with it, so run the real validator here.
  const { minimizeAuditPayload } = await import("@/server/services/audit");
  mocks.writeAudit.mockImplementation(async (
    _ctx: unknown,
    input: {
      action: Parameters<typeof minimizeAuditPayload>[0];
      before?: Parameters<typeof minimizeAuditPayload>[1];
      after?: Parameters<typeof minimizeAuditPayload>[1];
    }
  ) => {
    // writeAudit minimizes both sides. This path writes no `before` today, so the before branch is
    // future-proofing rather than a gap being closed -- it costs nothing and catches a later path.
    for (const side of ["before", "after"] as const) {
      const payload = input[side];
      if (payload !== undefined && payload !== null) minimizeAuditPayload(input.action, payload, side);
    }
  });
  mocks.getContextForBaby.mockResolvedValue(ctx);
  mocks.claimStagedFeedPhotos.mockResolvedValue(undefined);
});

describe("what the save hands the executor", () => {
  // The fingerprint test below proves the hash is sensitive to the chosen photos, but not that the
  // service actually puts them in the intent it hands over. If a narrowed intent or a stripping schema
  // dropped them, a family who removed a picture and re-saved would get the original replayed back.
  it("includes the chosen photos in the intent it fingerprints", async () => {
    mocks.executeBrowserOperation.mockResolvedValue({ kind: "activity", code: "ok", activityId: "act-1", action: "create" });
    const { submitActivityCreateBrowserOperation } = await import("./activities");

    await submitActivityCreateBrowserOperation(entry({ attachmentIds: ["att-1", "att-2"] }));

    const contract = mocks.executeBrowserOperation.mock.calls[0][0] as { intent: { attachmentIds?: string[] } };
    expect(contract.intent.attachmentIds).toEqual(["att-1", "att-2"]);
  });
});

describe("the audit guard protecting these tests", () => {
  // Without this, a future beforeEach calling mockReset would silently restore a stub that validates
  // nothing, and every assertion below would keep passing while the real contract went unchecked.
  // That already happened once. This fails the moment the guard stops being installed.
  it("is installed, so a malformed payload cannot pass unnoticed", async () => {
    await expect(mocks.writeAudit(ctx, {
      action: "feed_post.create",
      entityType: "feed_post",
      entityId: "post-1",
      after: { activityId: "act-1", photoCount: 1 }
    // Matched on the schema's own words. A bare toThrow() also passes when the stub throws for an
    // unrelated reason, which would hide the guard having been removed.
    })).rejects.toThrow(/Unrecognized key/);
  });

  it("accepts the shape this path actually writes", async () => {
    await expect(mocks.writeAudit(ctx, {
      action: "feed_post.create",
      entityType: "feed_post",
      entityId: "post-1",
      after: { tagCount: 0, photoCount: 1 }
    })).resolves.toBeUndefined();
  });
});

describe("logging an entry with a photo", () => {
  it("creates the entry, its photo post, and claims the photo in one save", async () => {
    const calls: string[] = [];
    const tx = transaction(calls);
    mocks.executeBrowserOperation.mockImplementation(async (contract: { execute: Function }) => {
      await contract.execute(tx, ctx, baby);
      return { kind: "activity", code: "ok" };
    });
    const { submitActivityCreateBrowserOperation } = await import("./activities");

    await submitActivityCreateBrowserOperation(entry({ attachmentIds: ["att-1"] }));

    // One transaction: the entry, then the post that carries the picture, then the claim.
    expect(calls).toEqual(["activity", "post"]);
    expect(mocks.claimStagedFeedPhotos).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ householdId: "house-1" }),
      expect.objectContaining({ attachmentIds: ["att-1"], postId: "post-new" })
    );
  });

  it("links the photo post to the entry it was logged with", async () => {
    const tx = transaction([]);
    mocks.executeBrowserOperation.mockImplementation(async (contract: { execute: Function }) => {
      await contract.execute(tx, ctx, baby);
      return { kind: "activity", code: "ok" };
    });
    const { submitActivityCreateBrowserOperation } = await import("./activities");

    await submitActivityCreateBrowserOperation(entry({ attachmentIds: ["att-1"] }));

    // The link is what makes Moments show one combined moment instead of two things.
    expect(tx.feedPost.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ activityId: "act-new", babyId: "baby-1" }) })
    );
  });

  it("writes no post at all when the entry is logged without a photo", async () => {
    const calls: string[] = [];
    const tx = transaction(calls);
    mocks.executeBrowserOperation.mockImplementation(async (contract: { execute: Function }) => {
      await contract.execute(tx, ctx, baby);
      return { kind: "activity", code: "ok" };
    });
    const { submitActivityCreateBrowserOperation } = await import("./activities");

    await submitActivityCreateBrowserOperation(entry());

    expect(calls).toEqual(["activity"]);
    expect(tx.feedPost.create).not.toHaveBeenCalled();
    expect(mocks.claimStagedFeedPhotos).not.toHaveBeenCalled();
  });

  it("fails the whole save when the photo cannot be claimed", async () => {
    // A picture that cannot be attached must not leave a logged entry behind claiming to have one.
    // The surrounding transaction is what undoes it, so the error has to escape.
    const tx = transaction([]);
    mocks.claimStagedFeedPhotos.mockRejectedValue(new Error("not_found"));
    mocks.executeBrowserOperation.mockImplementation(async (contract: { execute: Function }) =>
      contract.execute(tx, ctx, baby));
    const { submitActivityCreateBrowserOperation } = await import("./activities");

    await expect(
      submitActivityCreateBrowserOperation(entry({ attachmentIds: ["att-gone"] }))
    ).rejects.toThrow("not_found");
  });

  it("refuses a photo from someone who may not post to the feed", async () => {
    // Logging an entry needs activity.create; attaching a picture is a feed post and needs feed.post.
    const tx = transaction([]);
    mocks.executeBrowserOperation.mockImplementation(async (contract: { execute: Function }) =>
      contract.execute(tx, { ...ctx, role: "read_only" as const }, baby));
    const { submitActivityCreateBrowserOperation } = await import("./activities");

    await expect(
      submitActivityCreateBrowserOperation(entry({ attachmentIds: ["att-1"] }))
    ).rejects.toThrow();
    expect(mocks.claimStagedFeedPhotos).not.toHaveBeenCalled();
  });

  it("still logs the entry for a read-only member when no photo is attached", async () => {
    // The feed permission is required only by the picture, so it must not gate ordinary logging.
    const calls: string[] = [];
    const tx = transaction(calls);
    mocks.executeBrowserOperation.mockImplementation(async (contract: { execute: Function }) => {
      await contract.execute(tx, { ...ctx, role: "read_only" as const }, baby);
      return { kind: "activity", code: "ok" };
    });
    const { submitActivityCreateBrowserOperation } = await import("./activities");

    await submitActivityCreateBrowserOperation(entry());

    expect(calls).toEqual(["activity"]);
  });
});

describe("the photo work stays inside the save's own transaction", () => {
  it("uses the very transaction the executor wrapped, not one of its own", async () => {
    // If the photo post were created in a separate transaction, a crash between the two would leave a
    // logged entry with no photo. The only way to rule that out is to require the same handle.
    const tx = transaction([]);
    let handed: unknown;
    mocks.executeBrowserOperation.mockImplementation(async (contract: { execute: Function }) => {
      handed = tx;
      await contract.execute(tx, ctx, baby);
      return { kind: "activity", code: "ok" };
    });
    const { submitActivityCreateBrowserOperation } = await import("./activities");

    await submitActivityCreateBrowserOperation(entry({ attachmentIds: ["att-1"] }));

    expect(mocks.claimStagedFeedPhotos.mock.calls[0]![0]).toBe(handed);
    // And the post was created through that same handle, not through the module-level client.
    expect(tx.feedPost.create).toHaveBeenCalled();
  });

  it("lets a failure in the photo work escape, so the save is rolled back", async () => {
    // The executor rolls its savepoint back when execute rejects. Swallowing the error here would
    // commit a logged entry that claims a photo it never got.
    const tx = transaction([]);
    tx.feedPost.create = vi.fn(async () => { throw new Error("post_failed"); });
    mocks.executeBrowserOperation.mockImplementation(async (contract: { execute: Function }) =>
      contract.execute(tx, ctx, baby));
    const { submitActivityCreateBrowserOperation } = await import("./activities");

    await expect(
      submitActivityCreateBrowserOperation(entry({ attachmentIds: ["att-1"] }))
    ).rejects.toThrow("post_failed");
    expect(mocks.claimStagedFeedPhotos).not.toHaveBeenCalled();
  });
});

describe("a backdated entry keeps its photo with it", () => {
  it("dates the photo post to the entry, not to the moment it was uploaded", async () => {
    // A family logging yesterday's bath with a photo: the entry sorts at yesterday, so a post dated
    // now would drift to the top of today and show as a separate caption-less moment. Moments only
    // folds the two together when both land in the same page of the timeline.
    const tx = transaction([]);
    mocks.executeBrowserOperation.mockImplementation(async (contract: { execute: Function }) => {
      await contract.execute(tx, ctx, baby);
      return { kind: "activity", code: "ok" };
    });
    const { submitActivityCreateBrowserOperation } = await import("./activities");

    await submitActivityCreateBrowserOperation(
      entry({ attachmentIds: ["att-1"], occurredAt: "2026-09-30T18:00:00.000Z" })
    );

    expect(tx.feedPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ occurredAt: new Date("2026-09-30T18:00:00.000Z") })
      })
    );
  });
});

describe("retrying a save cannot double-claim or resurrect a removed photo", () => {
  it("fingerprints the chosen photos, so a retry with different ones is refused", async () => {
    // The browser-operation layer replays a stored outcome for the SAME request and refuses a changed
    // one. That protection only reaches photos if the chosen ids are part of what is fingerprinted --
    // otherwise a family who removed a picture and saved again would have the original replayed back.
    const { browserIntentFingerprint } = await import("./browser-operations");
    const opening = "opening-1";
    const base = { babyId: "baby-1", type: "feeding", occurredAt: "2026-10-01T08:00:00.000Z" };

    const one = browserIntentFingerprint({ openingFingerprint: opening, payload: { ...base, attachmentIds: ["att-1"] } });
    const other = browserIntentFingerprint({ openingFingerprint: opening, payload: { ...base, attachmentIds: ["att-2"] } });
    const removed = browserIntentFingerprint({ openingFingerprint: opening, payload: base });
    const both = browserIntentFingerprint({ openingFingerprint: opening, payload: { ...base, attachmentIds: ["att-1", "att-2"] } });
    const same = browserIntentFingerprint({ openingFingerprint: opening, payload: { ...base, attachmentIds: ["att-1"] } });

    // The same request replays; every other combination is a different request.
    expect(same).toBe(one);
    expect(new Set([one, other, removed, both]).size).toBe(4);
  });

  it("refuses the same picture listed twice rather than claiming it twice", async () => {
    const tx = transaction([]);
    mocks.executeBrowserOperation.mockImplementation(async (contract: { execute: Function }) =>
      contract.execute(tx, ctx, baby));
    const { submitActivityCreateBrowserOperation } = await import("./activities");

    await expect(
      submitActivityCreateBrowserOperation(entry({ attachmentIds: ["att-1", "att-1"] }))
    ).rejects.toThrow();
    expect(mocks.claimStagedFeedPhotos).not.toHaveBeenCalled();
  });
});
