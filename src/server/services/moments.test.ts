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
import { parseMomentsCursor, type MomentsBoundary } from "@/lib/moments-pagination";

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

/**
 * Filters a fixture list the way the real source does: each source receives the shared boundary and
 * applies momentsAfter with ITS OWN kind, so the two halves of the total order are exercised.
 */
function applyBoundary<T extends { id: string; occurredAt: Date }>(
  rows: T[],
  kind: "activity" | "post",
  boundary?: MomentsBoundary
): T[] {
  // MOMENTS_QUERY reads occurredAt DESC, id DESC. The cursor's tie-break assumes that order, so a fake
  // source must deliver it too.
  const ordered = [...rows].sort(
    (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
  rows = ordered;
  if (!boundary) return rows;
  const at = new Date(boundary.at).getTime();
  if (kind !== boundary.kind) {
    return kind === "activity"
      ? rows.filter((row) => row.occurredAt.getTime() <= at)
      : rows.filter((row) => row.occurredAt.getTime() < at);
  }
  return rows.filter(
    (row) => row.occurredAt.getTime() < at || (row.occurredAt.getTime() === at && row.id < boundary.id)
  );
}

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

  it("still offers more when the two sources together overflow the page, though neither does alone", async () => {
    // 13 entries and 13 posts is 26 rows: a full page plus one. Asking each source separately whether
    // it had more says no, yet the page is built from both together -- so the 26th row and all the
    // history behind it would never be shown, and no 'load more' would hint that it existed.
    mocks.listActivities.mockResolvedValue(Array.from({ length: 13 }, (_, i) => activity(i * 2)));
    mocks.listFeedPosts.mockResolvedValue(Array.from({ length: 13 }, (_, i) => post(i * 2 + 1)));
    const { listMixedMoments } = await import("./moments");

    const { items, nextCursor } = await listMixedMoments({});

    expect(items).toHaveLength(HISTORY_PAGE_SIZE);
    expect(nextCursor).toBeDefined();
  });

  /**
   * Walks the whole timeline the way the app does and checks what a family would notice: nothing
   * missing, nothing shown twice, and the walk actually ends.
   *
   * Asserting only that everything appeared would miss a duplicate -- a boundary that re-shows one row
   * still shows everything -- so each of these is checked separately.
   */
  async function walkEverything(entries: ReturnType<typeof activity>[], posts: ReturnType<typeof post>[]) {
    mocks.listActivities.mockImplementation(async ({ momentsAfter: boundary }: { momentsAfter?: MomentsBoundary }) =>
      applyBoundary(entries, "activity", boundary).slice(0, HISTORY_PAGE_SIZE + 1));
    mocks.listFeedPosts.mockImplementation(async ({ momentsAfter: boundary }: { momentsAfter?: MomentsBoundary }) =>
      applyBoundary(posts, "post", boundary).slice(0, HISTORY_PAGE_SIZE + 1));
    const { listMixedMoments } = await import("./moments");

    const times = new Map<string, number>();
    const cursors = new Set<string>();
    let deadEnds = 0;
    let cursor: string | undefined;
    let pages = 0;
    let ended = false;
    for (;;) {
      const result = await listMixedMoments({ cursor });
      pages += 1;
      const ids = result.items.flatMap((item) =>
        item.kind === "activity"
          // A folded photo post shows up as its entry's photo rather than an item of its own, so the
          // photo's own post counts as seen through the id carried on the combined entry.
          ? [item.activity.id, ...(item.photoPostId ? [item.photoPostId] : [])]
          : [item.post.id]);
      const fresh = ids.filter((id) => !times.has(id));
      for (const id of ids) times.set(id, (times.get(id) ?? 0) + 1);

      // A page reached through 'load more' must show something, and something new, or the family taps
      // into a dead end.
      if (pages > 1 && (ids.length === 0 || fresh.length === 0)) deadEnds += 1;
      if (!result.nextCursor) { ended = true; break; }
      // The same cursor twice means the walk is going in circles.
      expect(cursors.has(result.nextCursor)).toBe(false);
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
      if (pages > entries.length + posts.length + 5) break;
    }

    return {
      ended,
      deadEnds,
      shown: times.size,
      duplicated: [...times.values()].filter((count) => count > 1).length,
      stored: entries.length + posts.length
    };
  }

  it("shows every entry and every post exactly once across the whole walk", async () => {
    const entries = Array.from({ length: 20 }, (_, i) => activity(i * 2));
    const posts = Array.from({ length: 20 }, (_, i) => post(i * 2 + 1));

    const walk = await walkEverything(entries, posts);

    expect(walk).toEqual({ ended: true, deadEnds: 0, shown: 40, duplicated: 0, stored: 40 });
  });

  it("shows everything exactly once for shapes that stress the page boundary", async () => {
    // Each of these broke, or could break, a different way: sources overflowing only together; a
    // same-instant cluster bigger than a page; photos newer and older than their entries.
    const shapes: { name: string; entries: ReturnType<typeof activity>[]; posts: ReturnType<typeof post>[] }[] = [
      {
        name: "overflow only in combination, over several pages",
        entries: Array.from({ length: 30 }, (_, i) => activity(i * 2)),
        posts: Array.from({ length: 30 }, (_, i) => post(i * 2 + 1))
      },
      {
        name: "a same-instant cluster larger than one page",
        entries: Array.from({ length: 15 }, (_, i) => ({ ...activity(i), occurredAt: new Date(base) })),
        posts: Array.from({ length: 15 }, (_, i) => ({ ...post(i), occurredAt: new Date(base) }))
      },
      {
        name: "photo posts newer than their entries",
        entries: Array.from({ length: 26 }, (_, i) => activity(i)),
        posts: Array.from({ length: 26 }, (_, i) => photoPostNewerThan(100 + i, `act-${i}`))
      },
      {
        name: "a photo post older than its entry",
        entries: Array.from({ length: 26 }, (_, i) => activity(i)),
        posts: [post(99, "act-0")]
      },
      { name: "one entry and a full page of posts", entries: [activity(0)], posts: Array.from({ length: 25 }, (_, i) => post(i + 1)) },
      {
        // Exactly one full page and nothing more: offering 'load more' here leads to an empty page,
        // which is the dead end an off-by-one in the has-more test produces.
        name: "exactly one full page, nothing behind it",
        entries: Array.from({ length: 12 }, (_, i) => activity(i * 2)),
        posts: Array.from({ length: 13 }, (_, i) => post(i * 2 + 1))
      },
      {
        name: "exactly two full pages, nothing behind them",
        entries: Array.from({ length: 25 }, (_, i) => activity(i * 2)),
        posts: Array.from({ length: 25 }, (_, i) => post(i * 2 + 1))
      },
      { name: "nothing at all", entries: [], posts: [] }
    ];

    for (const shape of shapes) {
      const walk = await walkEverything(shape.entries, shape.posts);
      expect({ shape: shape.name, ...walk }).toEqual({
        shape: shape.name,
        ended: true,
        deadEnds: 0,
        shown: shape.entries.length + shape.posts.length,
        duplicated: 0,
        stored: shape.entries.length + shape.posts.length
      });
    }
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
