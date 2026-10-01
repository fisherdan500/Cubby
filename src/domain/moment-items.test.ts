/**
 * An entry and its photo as one moment.
 *
 * Moments merges posts and logged entries into one list. A photo added to an entry is stored as an
 * ordinary feed photo on a real post -- that is what keeps private delivery and backups working --
 * but the family should not see the entry and its photo as two separate things that happened at the
 * same time. One feed with a picture is one moment.
 *
 * The post stays the owner of the photo; it is only presented inside its entry.
 */
import { describe, expect, it } from "vitest";

import { mergeMomentItems } from "@/domain/moment-items";

const at = (iso: string) => new Date(iso);

const activity = (id: string, iso: string) => ({ id, occurredAt: at(iso) });
const post = (id: string, iso: string, activityId: string | null = null) => ({
  id,
  occurredAt: at(iso),
  activityId,
  photos: [{ id: `${id}-photo` }]
});

describe("combining an entry with its own photo post", () => {
  it("shows one moment, not the entry and its photo separately", () => {
    const items = mergeMomentItems({
      posts: [post("post-1", "2026-10-01T08:00:00.000Z", "act-1")],
      activities: [activity("act-1", "2026-10-01T08:00:00.000Z")]
    });

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("activity");
  });

  it("carries the photo into the entry's moment", () => {
    const items = mergeMomentItems({
      posts: [post("post-1", "2026-10-01T08:00:00.000Z", "act-1")],
      activities: [activity("act-1", "2026-10-01T08:00:00.000Z")]
    });

    const item = items[0]!;
    expect(item.kind === "activity" && item.photos.map((p) => p.id)).toEqual(["post-1-photo"]);
  });

  it("keeps the owning post's id, so the photo is still delivered and backed up as that post's", () => {
    // The photo must remain a feed photo on a real post: delivery and the backup export both require
    // a parent post, so a combined presentation must not detach it.
    const items = mergeMomentItems({
      posts: [post("post-1", "2026-10-01T08:00:00.000Z", "act-1")],
      activities: [activity("act-1", "2026-10-01T08:00:00.000Z")]
    });

    const item = items[0]!;
    expect(item.kind === "activity" && item.photoPostId).toBe("post-1");
  });

  it("leaves an ordinary post on its own", () => {
    const items = mergeMomentItems({
      posts: [post("post-free", "2026-10-01T09:00:00.000Z", null)],
      activities: [activity("act-1", "2026-10-01T08:00:00.000Z")]
    });

    expect(items.map((i) => i.kind)).toEqual(["post", "activity"]);
  });

  it("leaves an entry with no photo post on its own", () => {
    const items = mergeMomentItems({ posts: [], activities: [activity("act-1", "2026-10-01T08:00:00.000Z")] });

    const item = items[0]!;
    expect(item.kind === "activity" && item.photos).toEqual([]);
  });

  it("keeps newest first across combined and ordinary moments", () => {
    const items = mergeMomentItems({
      posts: [
        post("post-late", "2026-10-01T12:00:00.000Z", null),
        post("post-1", "2026-10-01T08:00:00.000Z", "act-1")
      ],
      activities: [activity("act-1", "2026-10-01T08:00:00.000Z"), activity("act-2", "2026-10-01T10:00:00.000Z")]
    });

    // Sorted by when each moment happened, and the combined one sits at its entry's time.
    expect(items.map((i) => (i.kind === "post" ? i.post.id : i.activity.id))).toEqual([
      "post-late",
      "act-2",
      "act-1"
    ]);
  });

  it("does not combine a photo post with an entry it does not belong to", () => {
    const items = mergeMomentItems({
      posts: [post("post-1", "2026-10-01T08:00:00.000Z", "other-activity")],
      activities: [activity("act-1", "2026-10-01T08:00:00.000Z")]
    });

    expect(items).toHaveLength(2);
  });

  it("combines every photo post belonging to the same entry", () => {
    const items = mergeMomentItems({
      posts: [
        post("post-a", "2026-10-01T08:00:00.000Z", "act-1"),
        post("post-b", "2026-10-01T08:05:00.000Z", "act-1")
      ],
      activities: [activity("act-1", "2026-10-01T08:00:00.000Z")]
    });

    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.kind === "activity" && item.photos.map((p) => p.id)).toEqual(["post-a-photo", "post-b-photo"]);
  });
});
