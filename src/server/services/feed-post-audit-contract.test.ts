/**
 * The audit payload builder lives in the domain layer; the strict schema that judges it lives here in
 * the server layer, and the domain deliberately does not import it. That keeps the layering clean but
 * leaves a drift risk: if the schema and the builder stop agreeing, every save that writes this row
 * fails INSIDE the transaction -- taking the family's entry down with it. That exact defect shipped
 * once on this feature.
 *
 * These cases hold the pair together in BOTH directions: the builder's output must be accepted, and the
 * schema must keep refusing what it is supposed to refuse. Positive cases alone would not notice the
 * schema being loosened. They are the reason the builder may stay in the domain layer.
 */
import { describe, expect, it, vi } from "vitest";

import { feedPostAuditPayload, FEED_POST_MAX_PHOTOS } from "@/domain/feed-post";
import { minimizeAuditPayload } from "@/server/services/audit";

// The audit module constructs a Prisma client at import. Nothing here touches a database, and this is
// what every other unit suite importing it does.
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));

const post = (tags: string[], photos: number) => ({
  tags,
  attachmentIds: Array.from({ length: photos }, (_, i) => `att-${i}`)
});

// Labelled, so a failure names WHICH shape broke: every shape failing means the schema gained or lost a
// field, while only the max-photos shape failing means its bound moved.
const shapes: [string, ReturnType<typeof post>][] = [
  ["a photo logged with an entry", post([], 1)],
  ["the most photos a post may carry", post([], FEED_POST_MAX_PHOTOS)],
  ["a caption with a tag, no photo", post(["bath"], 0)],
  ["a caption with tags and photos", post(["bath", "wren"], 3)],
  // Tags come from the caption, so an ordinary caption with no hashtags and no photo lands here. This
  // is the commonest feed_post.create payload in the product, not an unreachable edge case.
  ["an ordinary caption, no hashtags, no photo", post([], 0)]
];

describe("the feed_post.create audit payload the builder produces", () => {
  it.each(shapes)("is accepted by the schema for %s", (_label, shape) => {
    expect(() => minimizeAuditPayload("feed_post.create", feedPostAuditPayload(shape), "after")).not.toThrow();
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

describe("what the feed_post.create schema must keep refusing", () => {
  // Without these, the schema could be LOOSENED -- a required field made optional, strictness dropped --
  // and every case above would still pass while the audit record quietly stopped being what it claims.
  it("requires a tag count, so a row cannot omit it", () => {
    expect(() => minimizeAuditPayload("feed_post.create", { photoCount: 1 }, "after")).toThrow();
  });

  it("refuses a zero photo count rather than recording one", () => {
    expect(() => minimizeAuditPayload("feed_post.create", { tagCount: 0, photoCount: 0 }, "after")).toThrow();
  });

  it("refuses any extra key, so nothing about the caption can leak into the record", () => {
    expect(() => minimizeAuditPayload("feed_post.create", { tagCount: 0, caption: "bath time" }, "after"))
      .toThrow(/Unrecognized key/);
  });

  it("refuses more photos than a post may carry", () => {
    expect(() => minimizeAuditPayload("feed_post.create", { tagCount: 0, photoCount: FEED_POST_MAX_PHOTOS + 1 }, "after"))
      .toThrow();
  });
});
