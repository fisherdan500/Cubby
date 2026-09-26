// @vitest-environment jsdom
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUserPage: vi.fn(),
  getHeaderBabySelector: vi.fn(),
  listActivities: vi.fn(),
  getActivityRowViewer: vi.fn(),
  listFeedPosts: vi.fn(),
  listFeedInteractions: vi.fn(),
  getActivityUnitPreferences: vi.fn()
}));

globalThis.React = React;

vi.mock("@/server/auth/session", () => ({ requireUserPage: mocks.requireUserPage }));
vi.mock("@/server/services/baby-selector", () => ({ getHeaderBabySelector: mocks.getHeaderBabySelector }));
vi.mock("@/server/services/activities", () => ({ listActivities: mocks.listActivities, getActivityRowViewer: mocks.getActivityRowViewer }));
vi.mock("@/server/services/feed-posts", () => ({ listFeedPosts: mocks.listFeedPosts }));
vi.mock("@/server/services/feed-interactions", () => ({
  listFeedInteractions: mocks.listFeedInteractions,
  feedInteractionKey: (kind: string, id: string) => `${kind}:${id}`
}));
vi.mock("@/components/feed/feed-post-actions", () => ({
  FeedPostComposer: ({ babyName, photosEnabled }: { babyName: string; photosEnabled?: boolean }) =>
    createElement("div", { "data-composer": babyName, "data-photos": String(Boolean(photosEnabled)) }),
  FeedPostRemoveButton: ({ postId }: { postId: string }) => createElement("button", { type: "button", "data-remove": postId }, "Remove post"),
  FeedPostBody: ({ canEdit, edited, children }: { canEdit: boolean; edited: boolean; children: React.ReactNode }) =>
    createElement("p", { "data-can-edit": String(canEdit), "data-edited": String(edited) }, children)
}));
vi.mock("@/components/feed/feed-responses", () => ({
  FeedResponses: ({ parentKind, parentId, comments, reactions, canRespond }: {
    parentKind: string; parentId: string; comments: unknown[]; reactions: unknown[]; canRespond: boolean;
  }) => createElement("div", {
    "data-responses": `${parentKind}:${parentId}`,
    "data-comments": String(comments.length),
    "data-reactions": String(reactions.length),
    "data-can-respond": String(canRespond)
  })
}));
vi.mock("@/server/services/unit-preferences", () => ({ getActivityUnitPreferences: mocks.getActivityUnitPreferences }));
vi.mock("@/lib/env", () => ({ env: { APP_TIMEZONE: "UTC" } }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ title, children }: { title: string; children: React.ReactNode }) => createElement("main", { "data-title": title }, children)
}));
vi.mock("@/components/activity-artwork", () => ({ ActivityArtwork: () => createElement("span") }));

import FeedPage from "@/app/app/moments/page";

function entry(id: string, occurredAt: string, type: string, detail: Record<string, unknown> = {}) {
  return {
    id,
    type,
    occurredAt: new Date(occurredAt),
    durationSeconds: null,
    notes: null,
    actorMember: { displayName: "Sam", user: { name: "Sam Parent" } },
    baby: { id: "baby-1", name: "Avery", inactiveAt: null },
    ...detail
  };
}

async function renderFeed(searchParams: Record<string, string> = {}) {
  document.body.innerHTML = renderToStaticMarkup(await FeedPage({ searchParams }));
  return document.body;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T18:00:00Z"));
  mocks.requireUserPage.mockResolvedValue({ id: "user-1", name: "Sam" });
  mocks.getHeaderBabySelector.mockResolvedValue({ selectedBabyId: "baby-1", babies: [{ id: "baby-1", name: "Avery", ageLabel: "", inactive: false }] });
  mocks.getActivityUnitPreferences.mockResolvedValue({ preferences: { volume: "oz" } });
  mocks.getActivityRowViewer.mockResolvedValue({ memberId: "member-1", role: "caretaker" });
  mocks.listFeedPosts.mockResolvedValue([]);
  mocks.listFeedInteractions.mockResolvedValue({ comments: {}, reactions: {}, canRespond: true });
  mocks.listActivities.mockResolvedValue([
    entry("a1", "2026-09-25T15:00:00Z", "milestone", { milestone: { title: "Rolled over", category: "Motor" } }),
    entry("a2", "2026-09-25T09:00:00Z", "diaper", { diaper: { kind: "wet" } }),
    entry("a3", "2026-09-24T20:00:00Z", "note", { note: { text: "Giggled at the cat" } })
  ]);
});

describe("Feed page", () => {
  it("is a titled screen of cards for the selected baby, newest first, under their days", async () => {
    const body = await renderFeed({ babyId: "baby-1" });

    // Called Moments, not Feed: "Feed" means feeding the baby everywhere else in Cubby.
    expect(body.querySelector("main")?.getAttribute("data-title")).toBe("Moments");
    expect(mocks.listActivities).toHaveBeenCalledWith(expect.objectContaining({ babyId: "baby-1", type: undefined }));
    expect([...body.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["Today", "Yesterday"]);
    expect([...body.querySelectorAll("article")].map((card) => card.getAttribute("aria-label"))).toEqual(["Milestone", "Diaper", "Note"]);
  });

  it("gives each card what it is, when, who logged it, and the thing worth reading", async () => {
    const body = await renderFeed({ babyId: "baby-1" });
    const [milestone, , note] = [...body.querySelectorAll("article")];

    expect(milestone.textContent).toContain("Rolled over");
    expect(milestone.textContent).toContain("3:00 PM");
    expect(milestone.textContent).toContain("Logged by Sam");
    expect(note.textContent).toContain("Giggled at the cat");
  });

  it("opens an entry and comes back to the same feed", async () => {
    const body = await renderFeed({ babyId: "baby-1", filter: "milestone" });
    const href = body.querySelector("article a")?.getAttribute("href") ?? "";

    expect(href).toMatch(/^\/app\/activities\/a1\?/);
    expect(new URL(href, "https://cubby.invalid").searchParams.get("returnTo")).toBe("/app/moments?babyId=baby-1&filter=milestone");
  });

  it("filters from the header, marking the filter in use", async () => {
    const body = await renderFeed({ babyId: "baby-1", filter: "milestone" });
    const filters = [...body.querySelectorAll('nav[aria-label="Moments filters"] a')];

    expect(mocks.listActivities).toHaveBeenCalledWith(expect.objectContaining({ type: "milestone" }));
    expect(filters.map((link) => link.textContent)).toEqual(["Everything", "Posts", "Photos", "Feeds", "Sleep", "Diapers", "Milestones", "Notes"]);
    // A kind-of-entry filter shows entries alone.
    expect(mocks.listFeedPosts).not.toHaveBeenCalled();
    expect(filters.find((link) => link.getAttribute("aria-current") === "true")?.textContent).toBe("Milestones");
    expect(filters[0].getAttribute("href")).toBe("/app/moments?babyId=baby-1");
  });

  it("pages back through older entries", async () => {
    mocks.listActivities.mockResolvedValue(Array.from({ length: 26 }, (_, index) =>
      entry(`a${index}`, new Date(Date.parse("2026-09-25T15:00:00Z") - index * 3_600_000).toISOString(), "diaper", { diaper: { kind: "wet" } })
    ));
    const body = await renderFeed({ babyId: "baby-1" });

    expect(body.querySelectorAll("article")).toHaveLength(25);
    const older = [...body.querySelectorAll("a")].find((link) => link.textContent === "Older entries");
    // The next page continues from the last entry shown, so posts are neither skipped nor repeated.
    // The 25th entry shown (a24) is 24 hours before the first: 15:00 on the 24th.
    expect(older?.getAttribute("href")).toBe("/app/moments?babyId=baby-1&cursor=a24&before=2026-09-24T15%3A00%3A00.000Z");
    expect(mocks.listFeedPosts).toHaveBeenCalledWith(expect.objectContaining({ from: new Date("2026-09-24T15:00:00Z"), to: undefined }));
  });

  it("mixes posts among entries by time, each with its author, text, tags and remove where allowed", async () => {
    mocks.listFeedPosts.mockResolvedValue([{
      id: "post-1", babyId: null, body: "Family walk #weekend", tags: ["weekend"], occurredAt: new Date("2026-09-25T12:00:00Z"),
      authorName: "Sam", canRemove: true
    }]);
    const body = await renderFeed({ babyId: "baby-1" });
    const cards = [...body.querySelectorAll("article")];

    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(["Milestone", "Post", "Diaper", "Note"]);
    expect(cards[1].textContent).toContain("Sam");
    expect(cards[1].textContent).toContain("The whole family");
    expect(cards[1].querySelector("a")?.getAttribute("href")).toBe("/app/moments?babyId=baby-1&filter=posts&tag=weekend");
    expect(cards[1].querySelector("[data-remove]")?.getAttribute("data-remove")).toBe("post-1");
  });

  it("shows only posts under Posts, and only a tag's posts when one is chosen", async () => {
    mocks.listFeedPosts.mockResolvedValue([{
      id: "post-1", babyId: "baby-1", body: "First bath #firsts", tags: ["firsts"], occurredAt: new Date("2026-09-25T12:00:00Z"),
      authorName: "Sam", canRemove: false
    }]);
    const body = await renderFeed({ babyId: "baby-1", filter: "posts", tag: "firsts" });

    expect(mocks.listActivities).not.toHaveBeenCalled();
    expect(mocks.listFeedPosts).toHaveBeenCalledWith(expect.objectContaining({ babyId: "baby-1", tag: "firsts" }));
    expect([...body.querySelectorAll("article")].map((card) => card.getAttribute("aria-label"))).toEqual(["Post"]);
    expect(body.textContent).toContain("Posts tagged #firsts");
    expect(body.querySelector("[data-remove]")).toBeNull();
  });

  it("offers the composer to those who may post, and not to read-only members", async () => {
    let body = await renderFeed({ babyId: "baby-1" });
    expect(body.querySelector("[data-composer]")?.getAttribute("data-composer")).toBe("Avery");

    mocks.getActivityRowViewer.mockResolvedValue({ memberId: "member-9", role: "read_only" });
    body = await renderFeed({ babyId: "baby-1" });
    expect(body.querySelector("[data-composer]")).toBeNull();
  });

  it("puts the family's reactions and comments under every post and entry shown", async () => {
    mocks.listFeedPosts.mockResolvedValue([{
      id: "post-1", babyId: null, body: "Family walk", tags: [], occurredAt: new Date("2026-09-25T12:00:00Z"),
      authorName: "Sam", canRemove: true, canEdit: true, edited: true
    }]);
    mocks.listFeedInteractions.mockResolvedValue({
      comments: { "activity:a1": [{ id: "comment-1" }, { id: "comment-2" }] },
      reactions: { "post:post-1": [{ key: "love" }] },
      canRespond: true
    });
    const body = await renderFeed({ babyId: "baby-1" });

    expect(mocks.listFeedInteractions).toHaveBeenCalledWith({ postIds: ["post-1"], activityIds: ["a1", "a2", "a3"] });
    const cards = [...body.querySelectorAll("article")];
    expect(cards.map((card) => card.querySelector("[data-responses]")?.getAttribute("data-responses")))
      .toEqual(["activity:a1", "post:post-1", "activity:a2", "activity:a3"]);
    expect(cards[0].querySelector("[data-responses]")?.getAttribute("data-comments")).toBe("2");
    expect(cards[1].querySelector("[data-responses]")?.getAttribute("data-reactions")).toBe("1");
    // Responding sits beside the entry's link, not inside it.
    expect(cards[0].querySelector("a [data-responses]")).toBeNull();
    expect(cards[1].querySelector("[data-can-edit]")?.getAttribute("data-can-edit")).toBe("true");
    expect(cards[1].querySelector("[data-edited]")?.getAttribute("data-edited")).toBe("true");
  });

  it("shows a post's photos from the private photo address, in order, sized as stored", async () => {
    mocks.listFeedPosts.mockResolvedValue([{
      id: "post-1", babyId: null, body: "", tags: [], occurredAt: new Date("2026-09-25T12:00:00Z"),
      authorName: "Sam", canRemove: false, canEdit: false, edited: false,
      photos: [{ id: "photo-a", width: 2560, height: 1920 }, { id: "photo-b", width: 1440, height: 2560 }]
    }]);
    const body = await renderFeed({ babyId: "baby-1" });
    const post = [...body.querySelectorAll("article")].find((card) => card.getAttribute("aria-label") === "Post")!;
    const images = [...post.querySelectorAll("img")];

    expect(images.map((image) => [image.getAttribute("src"), image.getAttribute("width"), image.getAttribute("height"), image.getAttribute("alt")])).toEqual([
      ["/api/attachments/photo-a?size=thumbnail", "2560", "1920", "Photo 1 of 2"],
      ["/api/attachments/photo-b?size=thumbnail", "1440", "2560", "Photo 2 of 2"]
    ]);
    expect(images.every((image) => image.getAttribute("loading") === "lazy")).toBe(true);
    // A photo opens in a viewer inside the feed; a link away stranded the installed app on the raw image.
    expect(images[0].closest("a")).toBeNull();
    expect(images[0].closest("button")?.getAttribute("aria-label")).toBe("Open photo 1 of 2");
  });

  it("offers photos in the composer now they are switched on, and links to recently removed posts", async () => {
    const body = await renderFeed({ babyId: "baby-1" });
    expect(body.querySelector("[data-composer]")?.getAttribute("data-photos")).toBe("true");
    const removed = [...body.querySelectorAll("a")].find((link) => link.textContent === "Recently removed");
    expect(removed?.getAttribute("href")).toBe("/app/moments/removed?babyId=baby-1");

    mocks.getActivityRowViewer.mockResolvedValue({ memberId: "member-9", role: "read_only" });
    const readOnly = await renderFeed({ babyId: "baby-1" });
    expect([...readOnly.querySelectorAll("a")].some((link) => link.textContent === "Recently removed")).toBe(false);
  });

  describe("Photos", () => {
    const post = (id: string, photoIds: string[]) => ({
      id, babyId: null, body: "", tags: [], occurredAt: new Date("2026-09-25T12:00:00Z"),
      authorName: "Sam", canRemove: false, canEdit: false, edited: false,
      photos: photoIds.map((photoId) => ({ id: photoId, width: 1200, height: 900 }))
    });

    it("gathers every post's photos into one grid, newest post first, each opening in the viewer", async () => {
      mocks.listFeedPosts.mockResolvedValue([post("post-2", ["photo-c"]), post("post-1", ["photo-a", "photo-b"])]);
      const body = await renderFeed({ babyId: "baby-1", filter: "photos" });

      expect(mocks.listFeedPosts).toHaveBeenCalledWith(expect.objectContaining({ babyId: "baby-1", withPhotos: true }));
      expect(mocks.listActivities).not.toHaveBeenCalled();
      expect(mocks.listFeedInteractions).not.toHaveBeenCalled();
      const grid = body.querySelector('ul[aria-label="Photos"]')!;
      expect([...grid.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual([
        "/api/attachments/photo-c?size=thumbnail",
        "/api/attachments/photo-a?size=thumbnail",
        "/api/attachments/photo-b?size=thumbnail"
      ]);
      expect([...grid.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")))
        .toEqual(["Open photo 1 of 3", "Open photo 2 of 3", "Open photo 3 of 3"]);
      // A gallery, not the posts again.
      expect(body.querySelectorAll("article")).toHaveLength(0);
      expect(body.querySelector('nav[aria-label="Moments filters"] a[aria-current="true"]')?.textContent).toBe("Photos");
    });

    it("pages back through older posts' photos", async () => {
      mocks.listFeedPosts.mockResolvedValue(Array.from({ length: 26 }, (_, index) => post(`post-${index}`, [`photo-${index}`])));
      const body = await renderFeed({ babyId: "baby-1", filter: "photos" });

      expect(body.querySelectorAll('ul[aria-label="Photos"] img')).toHaveLength(25);
      const older = [...body.querySelectorAll("a")].find((link) => link.textContent === "Older photos");
      expect(older?.getAttribute("href")).toBe("/app/moments?babyId=baby-1&filter=photos&cursor=post-24");
    });

    it("says where photos come from when there are none yet", async () => {
      const body = await renderFeed({ babyId: "baby-1", filter: "photos" });
      expect(body.textContent).toContain("No photos yet. Photos shared in posts will gather here.");
    });
  });

  it("says so kindly when there is nothing yet", async () => {
    mocks.listActivities.mockResolvedValue([]);
    const body = await renderFeed({ babyId: "baby-1" });
    expect(body.textContent).toContain("Nothing here yet");
  });
});
