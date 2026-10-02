/**
 * The audit payload builder lives in the domain layer; the strict schema that judges it lives here in
 * the server layer, and the domain deliberately cannot import it. That keeps the layering clean but
 * leaves one untested drift direction: the schema gains a required field, the builder keeps omitting
 * it, and every save that writes this row starts failing INSIDE the transaction -- taking the family's
 * entry down with it. That exact defect shipped once on this feature.
 *
 * These cases hold the pair together. They are the reason the builder may stay in the domain layer.
 */
import { describe, expect, it } from "vitest";

import { feedPostAuditPayload, FEED_POST_MAX_PHOTOS } from "@/domain/feed-post";
import { minimizeAuditPayload } from "@/server/services/audit";

const post = (tags: string[], photos: number) => ({
  tags,
  attachmentIds: Array.from({ length: photos }, (_, i) => `att-${i}`)
});

describe("the feed_post.create audit payload the builder produces", () => {
  it("is accepted by the schema for every shape a create can produce", () => {
    const shapes = [
      post([], 1),                                     // a photo logged with an entry
      post([], FEED_POST_MAX_PHOTOS),                  // the most photos a post may carry
      post(["bath"], 0),                               // a caption with a tag, no photo
      post(["bath", "wren"], 3),                       // both
      post([], 0)                                      // neither (guarded upstream, still must not throw)
    ];

    for (const shape of shapes) {
      expect(() => minimizeAuditPayload("feed_post.create", feedPostAuditPayload(shape), "after")).not.toThrow();
    }
  });

  it("never reports a photo count of zero, which the schema refuses", () => {
    // photoCount is positive-only, so "no photos" must be an absent key rather than a zero.
    expect(feedPostAuditPayload(post([], 0))).not.toHaveProperty("photoCount");
    expect(feedPostAuditPayload(post([], 2))).toEqual({ tagCount: 0, photoCount: 2 });
  });

  it("carries no caption, ids, or anything else the uploader supplied", () => {
    // The audit row keeps counts only. A key naming the entry or the post is refused by the strict
    // schema, so smuggling one in would break the save rather than quietly widening the record.
    expect(Object.keys(feedPostAuditPayload(post(["bath"], 1))).sort()).toEqual(["photoCount", "tagCount"]);
  });
});
