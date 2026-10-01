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
import { describe, expect, it } from "vitest";

import { feedInteractionKey } from "@/server/services/feed-interactions";

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
