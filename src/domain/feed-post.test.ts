import { describe, expect, it } from "vitest";
import { FEED_POST_MAX_LENGTH, canRemoveFeedPost, feedPostTags, parseFeedPostInput } from "@/domain/feed-post";
import { hasPermission } from "@/domain/roles";

describe("feed post text", () => {
  it("takes #tags from the caption, lower-cased and once each, in the order written", () => {
    expect(feedPostTags("First bath! #Firsts #bathtime so much splashing #firsts")).toEqual(["firsts", "bathtime"]);
    expect(feedPostTags("Grandma visited #grandma_day #Oma2026")).toEqual(["grandma_day", "oma2026"]);
    expect(feedPostTags("No tags here, and a lone # is not one")).toEqual([]);
  });

  it("does not mistake a number or an anchor for a tag", () => {
    expect(feedPostTags("Weighed 3.4 kg, she is baby #1 in our hearts")).toEqual(["1"]);
    expect(feedPostTags("see page.html#section")).toEqual([]);
  });

  it("accepts a caption about one baby or the whole family, trimmed", () => {
    expect(parseFeedPostInput({ body: "  Rolled over today!  ", babyId: "baby-1" })).toEqual({ body: "Rolled over today!", babyId: "baby-1", tags: [] });
    expect(parseFeedPostInput({ body: "Family walk #weekend", babyId: null })).toEqual({ body: "Family walk #weekend", babyId: null, tags: ["weekend"] });
  });

  it("refuses an empty, overlong or control-character caption", () => {
    expect(() => parseFeedPostInput({ body: "   ", babyId: null })).toThrow();
    expect(() => parseFeedPostInput({ body: "x".repeat(FEED_POST_MAX_LENGTH + 1), babyId: null })).toThrow();
    expect(() => parseFeedPostInput({ body: "hello\u0007", babyId: null })).toThrow();
    expect(parseFeedPostInput({ body: "line one\nline two", babyId: null }).body).toBe("line one\nline two");
  });
});

describe("who may post and remove", () => {
  it("lets everyone but read-only members post", () => {
    for (const role of ["owner", "admin", "parent", "caretaker"] as const) expect(hasPermission(role, "feed.post")).toBe(true);
    expect(hasPermission("read_only", "feed.post")).toBe(false);
  });

  it("lets an author remove their own post, and owners, admins and parents remove any", () => {
    expect(canRemoveFeedPost("caretaker", true)).toBe(true);
    expect(canRemoveFeedPost("caretaker", false)).toBe(false);
    for (const role of ["owner", "admin", "parent"] as const) expect(canRemoveFeedPost(role, false)).toBe(true);
    expect(canRemoveFeedPost("read_only", false)).toBe(false);
  });
});
