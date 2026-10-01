/**
 * Creating the post that carries an entry's photo.
 *
 * A photo added to a logged entry is an ordinary feed photo on a real post -- that is what keeps
 * private delivery and backups working -- with the post recording which entry it belongs to. The
 * entry must be verified inside the write transaction, against the locked household, so a post can
 * never be linked to an entry in someone else's household or to one that has been deleted.
 */
import { describe, expect, it } from "vitest";

import { parseFeedPostActivityLink } from "@/domain/feed-post-activity";

describe("the entry a photo post belongs to", () => {
  it("accepts no entry at all, which is what an ordinary post has", () => {
    expect(parseFeedPostActivityLink(undefined)).toBeNull();
    expect(parseFeedPostActivityLink(null)).toBeNull();
  });

  it("accepts an entry id", () => {
    expect(parseFeedPostActivityLink("act-1")).toBe("act-1");
  });

  it("treats an empty or blank id as no entry rather than a broken link", () => {
    expect(parseFeedPostActivityLink("")).toBeNull();
    expect(parseFeedPostActivityLink("   ")).toBeNull();
  });

  it("refuses anything that is not a string, so a crafted payload cannot slip through", () => {
    expect(() => parseFeedPostActivityLink(42)).toThrow("invalid");
    expect(() => parseFeedPostActivityLink({ id: "act-1" })).toThrow("invalid");
    expect(() => parseFeedPostActivityLink(["act-1"])).toThrow("invalid");
    expect(() => parseFeedPostActivityLink(true)).toThrow("invalid");
  });

  it("does not trim a surrounding space into a different id", () => {
    // An id with padding is a malformed request, not a request about a trimmed id.
    expect(parseFeedPostActivityLink(" act-1 ")).toBe("act-1");
  });
});
