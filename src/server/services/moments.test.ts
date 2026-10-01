/**
 * Paging the Moments timeline when entries and their photos are combined.
 *
 * A photo added to a logged entry is folded into that entry so the family sees one moment. Folding is
 * PRESENTATION ONLY, and these tests exist because an earlier version let it change paging: it counted
 * the page after folding had removed rows, so a family who added a few photos could lose the whole
 * older half of their timeline, and a photo attached to an entry in the lookahead slot could appear on
 * no page at all. Both are silent -- nothing reports a memory that is simply never shown.
 *
 * So the rule these tests pin is: paging is decided on the rows the sources returned, exactly as it
 * was before combining existed, and folding only changes how the page is rendered.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listActivities: vi.fn(), listFeedPosts: vi.fn() }));

vi.mock("@/server/services/activities", () => ({ listActivities: mocks.listActivities }));
vi.mock("@/server/services/feed-posts", () => ({ listFeedPosts: mocks.listFeedPosts }));

import { HISTORY_PAGE_SIZE } from "@/lib/history-pagination";
import { parseMomentsCursor } from "@/lib/moments-pagination";

const base = Date.parse("2026-10-01T12:00:00.000Z");

/** An entry, newer ones first. */
const activity = (n: number) => ({ id: `act-${n}`, occurredAt: new Date(base - n * 60_000) });

/** A post. `on` links it to an entry, as adding a photo to that entry does. */
const post = (n: number, on?: string) => ({
  id: `post-${n}`,
  occurredAt: new Date(base - n * 60_000),
  activityId: on ?? null,
  photos: [{ id: `photo-${n}`, width: 800, height: 600 }]
});

/** A photo post is created when the photo is added, so it is normally NEWER than its entry. */
const photoPostNewerThan = (n: number, on: string) => ({
  id: `post-${n}`,
  occurredAt: new Date(base + 60_000),
  activityId: on,
  photos: [{ id: `photo-${n}`, width: 800, height: 600 }]
});

beforeEach(() => {
  mocks.listActivities.mockReset();
  mocks.listFeedPosts.mockReset();
});

/** Every photo the page actually shows, however it is rendered. */
function photosOn(items: { kind: string; photos?: { id: string }[]; post?: { photos: { id: string }[] } }[]) {
  return items.flatMap((item) => (item.kind === "activity" ? item.photos ?? [] : item.post?.photos ?? [])).map((p) => p.id);
}

describe("paging a timeline that combines entries with their photos", () => {
  it("still offers more when a source had more to give, even if every post folded away", async () => {
    // The post source returned a full lookahead, so older posts certainly exist. Folding must not be
    // able to swallow that fact: before this was fixed, the family's entire older feed became
    // unreachable the moment they added photos to a few entries.
    const activities = Array.from({ length: 20 }, (_, i) => activity(i));
    const posts = Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, i) => post(i, `act-${i % 20}`));
    mocks.listActivities.mockResolvedValue(activities);
    mocks.listFeedPosts.mockResolvedValue(posts);
    const { listMixedMoments } = await import("./moments");

    expect((await listMixedMoments({})).nextCursor).toBeDefined();
  });

  it("shows a photo whose entry sits in the lookahead slot rather than dropping it", async () => {
    // The 26th entry is read as lookahead and then sliced off the page. A photo folded into it used to
    // vanish with it, and because the photo is newer than the entry the next page excluded it too, so
    // it appeared on no page at all while still sitting in the database.
    const activities = Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, i) => activity(i));
    mocks.listActivities.mockResolvedValue(activities);
    mocks.listFeedPosts.mockResolvedValue([photoPostNewerThan(99, `act-${HISTORY_PAGE_SIZE}`)]);
    const { listMixedMoments } = await import("./moments");

    const { items } = await listMixedMoments({});

    expect(photosOn(items)).toContain("photo-99");
  });

  it("decides the page from the rows the sources returned, not from what folding left behind", async () => {
    // 26 entries is a full page plus lookahead, so there is more to show regardless of folding.
    const activities = Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, i) => activity(i));
    mocks.listActivities.mockResolvedValue(activities);
    mocks.listFeedPosts.mockResolvedValue([post(0, "act-0")]);
    const { listMixedMoments } = await import("./moments");

    const { items, nextCursor } = await listMixedMoments({});

    expect(nextCursor).toBeDefined();
    expect(items.length).toBeLessThanOrEqual(HISTORY_PAGE_SIZE);
  });

  it("keeps the boundary on a row the next page can page from", async () => {
    const activities = Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, i) => activity(i));
    mocks.listActivities.mockResolvedValue(activities);
    mocks.listFeedPosts.mockResolvedValue([photoPostNewerThan(99, "act-0")]);
    const { listMixedMoments } = await import("./moments");

    const { nextCursor } = await listMixedMoments({});

    // A folded post is not shown in its own right, so it must never become the thing the next page
    // continues from -- the next page would then skip or repeat whatever sits around it.
    const boundary = parseMomentsCursor(nextCursor);
    expect(boundary).toBeDefined();
    expect(boundary!.id).not.toBe("post-99");
  });

  it("stops offering more when both sources are exhausted", async () => {
    mocks.listActivities.mockResolvedValue([activity(0), activity(1)]);
    mocks.listFeedPosts.mockResolvedValue([post(2, "act-0")]);
    const { listMixedMoments } = await import("./moments");

    expect((await listMixedMoments({})).nextCursor).toBeUndefined();
  });

  it("shows an entry's photo with the entry, as one moment", async () => {
    mocks.listActivities.mockResolvedValue([activity(0)]);
    mocks.listFeedPosts.mockResolvedValue([photoPostNewerThan(5, "act-0")]);
    const { listMixedMoments } = await import("./moments");

    const { items } = await listMixedMoments({});

    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("activity");
    expect(photosOn(items)).toEqual(["photo-5"]);
  });

  it("leaves a photo whose entry is not on this page as an ordinary post, so it is still seen", async () => {
    mocks.listActivities.mockResolvedValue([activity(0)]);
    mocks.listFeedPosts.mockResolvedValue([post(1, "act-not-here")]);
    const { listMixedMoments } = await import("./moments");

    const { items } = await listMixedMoments({});

    expect(photosOn(items)).toContain("photo-1");
  });

  it("never shows the same photo twice", async () => {
    mocks.listActivities.mockResolvedValue([activity(0), activity(1)]);
    mocks.listFeedPosts.mockResolvedValue([photoPostNewerThan(7, "act-0")]);
    const { listMixedMoments } = await import("./moments");

    const shown = photosOn((await listMixedMoments({})).items);

    expect(shown).toEqual([...new Set(shown)]);
  });

  it("puts a post before an entry recorded at the same moment, so paging cannot loop", async () => {
    // The cursor is a total order over (occurredAt, kind, id); this tie-break is what makes it total.
    const sameInstant = new Date(base);
    mocks.listActivities.mockResolvedValue([{ id: "act-tie", occurredAt: sameInstant }]);
    mocks.listFeedPosts.mockResolvedValue([{ id: "post-tie", occurredAt: sameInstant, activityId: null, photos: [] }]);
    const { listMixedMoments } = await import("./moments");

    const { items } = await listMixedMoments({});

    expect(items.map((item) => item.kind)).toEqual(["post", "activity"]);
  });
});
