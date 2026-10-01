/**
 * The family's responses on the screen where an entry is actually opened.
 *
 * Comments on a logged entry already work in Moments -- FeedComment carries an activityId and the
 * write path accepts an activity parent. They were only ever shown in the feed, so someone looking
 * at the entry itself could not see what anyone had said about it, and could not reply without
 * leaving for Moments and finding it again.
 *
 * This is the same thread in both places, not a second one: the parent key is the activity, so a
 * comment left here is the comment seen there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { feedInteractionKey } from "@/server/services/feed-interactions";

const findMany = vi.hoisted(() => vi.fn());
const getContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db/prisma", () => ({ prisma: { feedPost: { findMany } } }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: getContext }));

describe("responses on a logged entry", () => {
  it("keys the thread by the activity, so the entry and the feed share it", () => {
    // Moments already builds its key this way for an activity item; the entry screen must agree or
    // the same conversation would appear as two.
    expect(feedInteractionKey("activity", "act-1")).toBe(feedInteractionKey("activity", "act-1"));
  });

  it("keeps an activity thread separate from a post that happens to share an id", () => {
    expect(feedInteractionKey("activity", "same-id")).not.toBe(feedInteractionKey("post", "same-id"));
  });
});

describe("loading the thread for one entry", () => {
  it("asks for exactly the one activity and no posts", async () => {
    // The entry screen shows one entry, so it must not fetch the whole feed's interactions.
    const { activityResponsesQuery } = await import("@/server/services/activity-responses");

    expect(activityResponsesQuery("act-1")).toEqual({ postIds: [], activityIds: ["act-1"] });
  });
});


describe("an entry's own photos", () => {
  beforeEach(() => {
    findMany.mockReset();
    getContext.mockReset();
    getContext.mockResolvedValue({ householdId: "house-1", memberId: "member-1", userId: "user-1", role: "parent" });
  });

  it("asks only for this household's photo posts for this entry", async () => {
    findMany.mockResolvedValue([]);
    const { listActivityPhotos } = await import("./activity-responses");

    await listActivityPhotos("act-1");

    // Scoped to the household as well as the entry: never another household's post.
    expect(findMany.mock.calls[0][0].where).toEqual({
      householdId: "house-1",
      activityId: "act-1",
      deletedAt: null
    });
  });

  it("asks for the oldest post first, so pictures read in the order they were added", async () => {
    findMany.mockResolvedValue([]);
    const { listActivityPhotos } = await import("./activity-responses");

    await listActivityPhotos("act-1");

    expect(findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: "asc" });
  });

  it("shows only photos that are actually available", async () => {
    findMany.mockResolvedValue([]);
    const { listActivityPhotos } = await import("./activity-responses");

    await listActivityPhotos("act-1");

    // A withdrawn or still-uploading photo must not appear on the entry.
    expect(findMany.mock.calls[0][0].select.photos.where).toEqual({ state: "available" });
  });

  it("returns the photos of those posts, oldest post first", async () => {
    findMany.mockResolvedValue([
      { id: "post-a", photos: [{ id: "p1", width: 800, height: 600 }] },
      { id: "post-b", photos: [{ id: "p2", width: 400, height: 300 }] }
    ]);
    const { listActivityPhotos } = await import("./activity-responses");

    expect((await listActivityPhotos("act-1")).map((photo) => photo.id)).toEqual(["p1", "p2"]);
  });

  it("gives back nothing for an entry with no photos", async () => {
    findMany.mockResolvedValue([]);
    const { listActivityPhotos } = await import("./activity-responses");

    expect(await listActivityPhotos("act-1")).toEqual([]);
  });

  it("does not include a removed post's photos", async () => {
    findMany.mockResolvedValue([]);
    const { listActivityPhotos } = await import("./activity-responses");

    await listActivityPhotos("act-1");

    // A removed post's photos are recoverable but not shown.
    expect(findMany.mock.calls[0][0].where.deletedAt).toBeNull();
  });
});
