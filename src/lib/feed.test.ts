import { describe, expect, it } from "vitest";
import { feedFilters, feedHref, groupFeedByDay, resolveFeedFilter } from "@/lib/feed";

describe("feed filters", () => {
  it("offers everything first, then posts, then the kinds of entry people look for", () => {
    expect(feedFilters.map((filter) => filter.label)).toEqual(["Everything", "Posts", "Feeds", "Sleep", "Diapers", "Milestones", "Notes"]);
    expect(resolveFeedFilter("posts")).toMatchObject({ key: "posts", type: undefined, posts: "only" });
    expect(resolveFeedFilter("all")).toMatchObject({ posts: "mixed" });
    expect(resolveFeedFilter("sleep")).toMatchObject({ posts: "none" });
  });

  it("links to a tag, and to the next page with the time it continues from", () => {
    expect(feedHref({ babyId: "baby-1", filter: "posts", tag: "firsts" })).toBe("/app/feed?babyId=baby-1&filter=posts&tag=firsts");
    expect(feedHref({ babyId: "baby-1", cursor: "a24", before: "2026-09-24T10:00:00.000Z" }))
      .toBe("/app/feed?babyId=baby-1&cursor=a24&before=2026-09-24T10%3A00%3A00.000Z");
  });

  it("treats a missing or unknown filter as everything", () => {
    expect(resolveFeedFilter(undefined).key).toBe("all");
    expect(resolveFeedFilter("not-a-type").key).toBe("all");
    expect(resolveFeedFilter("milestone")).toMatchObject({ key: "milestone", type: "milestone" });
  });

  it("links to a filter and page for the selected baby, leaving out what is default", () => {
    expect(feedHref({})).toBe("/app/feed");
    expect(feedHref({ babyId: "baby 1", filter: "all" })).toBe("/app/feed?babyId=baby+1");
    expect(feedHref({ babyId: "baby-1", filter: "sleep", cursor: "activity-9" })).toBe("/app/feed?babyId=baby-1&filter=sleep&cursor=activity-9");
  });
});

describe("groupFeedByDay", () => {
  const at = (iso: string) => ({ id: iso, occurredAt: new Date(iso) });

  it("groups entries under household days, saying Today and Yesterday rather than a date", () => {
    const groups = groupFeedByDay(
      [at("2026-09-25T14:00:00Z"), at("2026-09-25T02:00:00Z"), at("2026-09-24T15:00:00Z"), at("2026-09-21T15:00:00Z")],
      "America/New_York",
      new Date("2026-09-25T16:00:00Z")
    );

    // 02:00Z on the 25th is still the evening of the 24th in New York.
    expect(groups.map((group) => [group.label, group.items.length])).toEqual([
      ["Today", 1],
      ["Yesterday", 2],
      ["Mon, Sep 21", 1]
    ]);
  });

  it("names the year only when it is not this year", () => {
    const [group] = groupFeedByDay([at("2025-12-30T15:00:00Z")], "UTC", new Date("2026-09-25T12:00:00Z"));
    expect(group.label).toBe("Tue, Dec 30, 2025");
  });
});
