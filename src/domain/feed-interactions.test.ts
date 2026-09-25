import { describe, expect, it } from "vitest";
import {
  FEED_COMMENT_MAX_LENGTH,
  canEditFeedComment,
  canRemoveFeedComment,
  feedReactions,
  joinNames,
  parseFeedCommentInput,
  parseFeedParent,
  parseFeedReactionInput,
  summarizeFeedReactions
} from "@/domain/feed-interactions";
import { canEditFeedPost } from "@/domain/feed-post";
import { hasPermission } from "@/domain/roles";

describe("feed reactions", () => {
  it("offers five reactions, in a fixed order, each with a name to read aloud", () => {
    expect(feedReactions.map((reaction) => [reaction.key, reaction.emoji, reaction.label])).toEqual([
      ["love", "❤️", "love"],
      ["funny", "😂", "funny"],
      // 🥰 rather than 🥹: the newer face showed as an empty box on some phones.
      ["aww", "🥰", "aww"],
      ["celebrate", "🎉", "celebrate"],
      ["well_done", "👏", "well done"]
    ]);
  });

  it("shows who reacted by name - the viewer as You, first - and never a count", () => {
    const summary = summarizeFeedReactions([
      { reaction: "celebrate", memberId: "member-2", name: "Alex" },
      { reaction: "love", memberId: "member-2", name: "Alex" },
      { reaction: "love", memberId: "member-1", name: "Sam" },
      { reaction: "love", memberId: null, name: "Grandma" }
    ], "member-1");

    expect(summary).toEqual([
      { key: "love", emoji: "❤️", label: "love", names: ["You", "Alex", "Grandma"], mine: true },
      { key: "celebrate", emoji: "🎉", label: "celebrate", names: ["Alex"], mine: false }
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/count|total/i);
  });

  it("reads a list of names the way a person would say it", () => {
    expect(joinNames(["Sam"])).toBe("Sam");
    expect(joinNames(["You", "Alex"])).toBe("You and Alex");
    expect(joinNames(["You", "Alex", "Grandma"])).toBe("You, Alex and Grandma");
  });

  it("accepts only the offered reactions, turned on or off, on a post or a logged entry", () => {
    expect(parseFeedReactionInput({ parentKind: "post", parentId: "post-1", reaction: "aww", on: true }))
      .toEqual({ parentKind: "post", parentId: "post-1", reaction: "aww", on: true });
    expect(parseFeedReactionInput({ parentKind: "activity", parentId: "activity-1", reaction: "well_done", on: false }).on).toBe(false);
    expect(() => parseFeedReactionInput({ parentKind: "post", parentId: "post-1", reaction: "thumbs_down", on: true })).toThrow();
    expect(() => parseFeedReactionInput({ parentKind: "post", parentId: "post-1", reaction: "love" })).toThrow();
    expect(() => parseFeedParent({ parentKind: "baby", parentId: "baby-1" })).toThrow();
  });
});

describe("feed comments", () => {
  it("accepts a trimmed comment with line breaks, and refuses an empty, overlong or control-character one", () => {
    expect(parseFeedCommentInput({ body: "  So cute!\nLove it  " })).toEqual({ body: "So cute!\nLove it" });
    expect(() => parseFeedCommentInput({ body: "  " })).toThrow();
    expect(() => parseFeedCommentInput({ body: "x".repeat(FEED_COMMENT_MAX_LENGTH + 1) })).toThrow();
    expect(() => parseFeedCommentInput({ body: "hi\u0007" })).toThrow();
  });

  it("lets every member comment and react, read-only members included", () => {
    for (const role of ["owner", "admin", "parent", "caretaker", "read_only"] as const) {
      expect(hasPermission(role, "feed.comment")).toBe(true);
    }
  });

  it("lets only the author edit a comment", () => {
    expect(canEditFeedComment("read_only", true)).toBe(true);
    expect(canEditFeedComment("owner", false)).toBe(false);
  });

  it("lets the author remove their own comment, and owners, admins and parents remove any", () => {
    expect(canRemoveFeedComment("read_only", true)).toBe(true);
    expect(canRemoveFeedComment("caretaker", false)).toBe(false);
    expect(canRemoveFeedComment("read_only", false)).toBe(false);
    for (const role of ["owner", "admin", "parent"] as const) expect(canRemoveFeedComment(role, false)).toBe(true);
  });
});

describe("editing posts", () => {
  it("lets only the author edit a post, and only while they may still post", () => {
    expect(canEditFeedPost("caretaker", true)).toBe(true);
    expect(canEditFeedPost("owner", false)).toBe(false);
    // A member made read-only keeps their posts but can no longer change them.
    expect(canEditFeedPost("read_only", true)).toBe(false);
  });
});
