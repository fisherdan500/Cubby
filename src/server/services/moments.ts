import { HISTORY_PAGE_SIZE } from "@/lib/history-pagination";
import { MOMENTS_QUERY, momentsCursor, parseMomentsCursor } from "@/lib/moments-pagination";
import { listActivities } from "@/server/services/activities";
import { listFeedPosts, type FeedPostView } from "@/server/services/feed-posts";

type ActivityItem = Awaited<ReturnType<typeof listActivities>>[number];
export type MomentItem =
  | {
      kind: "activity";
      at: Date;
      activity: ActivityItem;
      /** Photos from this entry's own photo posts; empty for an entry with no picture. */
      photos: FeedPostView["photos"];
      /** The post that owns those photos, so delivery and backup still see a parent post. */
      photoPostId: string | null;
    }
  | { kind: "post"; at: Date; post: FeedPostView };

/** One row from a source, before an entry's photo posts are folded into it for presentation. */
type MomentRow =
  | { kind: "activity"; at: Date; activity: ActivityItem }
  | { kind: "post"; at: Date; post: FeedPostView };

/** Each scoped source reads only a page plus lookahead; neither source owns continuation. */
export async function listMixedMoments({ babyId, cursor }: { babyId?: string; cursor?: string }) {
  const after = parseMomentsCursor(cursor);
  const [activities, posts] = await Promise.all([
    listActivities({ babyId, type: undefined, momentsAfter: after, page: MOMENTS_QUERY }),
    listFeedPosts({ babyId, momentsAfter: after, page: MOMENTS_QUERY })
  ]);
  // A photo added to an entry is stored as a feed photo on a real post, which is what keeps private
  // delivery and backups working. The family should still see one moment rather than the entry and
  // its photo side by side, so such a post is folded into its entry here, for presentation only.
  // Whether more history exists is decided by what the SOURCES returned, before any folding. Folding
  // changes presentation only; counting after it let a family who added photos to a few entries lose
  // the whole older half of their timeline, with nothing to tell them it had gone.
  const sourceHasMore = activities.length > HISTORY_PAGE_SIZE || posts.length > HISTORY_PAGE_SIZE;

  // Page the two sources together FIRST, exactly as they were paged before combining existed, so the
  // rows that make up this page are settled independently of folding.
  const rows: MomentRow[] = [
    ...posts.map((post): MomentRow => ({ kind: "post", at: post.occurredAt, post })),
    ...activities.map((activity): MomentRow => ({ kind: "activity", at: activity.occurredAt, activity }))
  ];
  // Stable sort retains the database's id order within each source (including its collation).
  rows.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.kind === b.kind ? 0 : a.kind === "post" ? -1 : 1));

  // The boundary is the last row of the page, and it must be a row the next page can continue from.
  // A folded post is not shown in its own right, so it must never become the boundary.
  const paged = rows.slice(0, HISTORY_PAGE_SIZE);
  const pagedActivityIds = new Set(
    paged.flatMap((row) => (row.kind === "activity" ? [row.activity.id] : []))
  );

  // Only a photo post whose entry is ON THIS PAGE folds into it. One whose entry is elsewhere stays an
  // ordinary post, so a picture is shown either way and never falls between two pages.
  const foldedByActivity = new Map<string, FeedPostView[]>();
  const items: MomentItem[] = [];
  for (const row of paged) {
    if (row.kind === "post" && row.post.activityId && pagedActivityIds.has(row.post.activityId)) {
      const group = foldedByActivity.get(row.post.activityId);
      if (group) group.push(row.post);
      else foldedByActivity.set(row.post.activityId, [row.post]);
    }
  }
  for (const row of paged) {
    if (row.kind === "post") {
      if (row.post.activityId && pagedActivityIds.has(row.post.activityId)) continue;
      items.push({ kind: "post", at: row.at, post: row.post });
      continue;
    }
    // Oldest post first, so an entry's pictures read in the order they were added, matching the
    // entry's own screen.
    const own = [...(foldedByActivity.get(row.activity.id) ?? [])].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()
    );
    items.push({
      kind: "activity",
      at: row.at,
      activity: row.activity,
      photos: own.flatMap((post) => post.photos),
      photoPostId: own[0]?.id ?? null
    });
  }

  const boundary = paged.at(-1);
  return {
    items,
    nextCursor: sourceHasMore && boundary ? momentsCursor({
      at: boundary.at.toISOString(),
      kind: boundary.kind,
      id: boundary.kind === "post" ? boundary.post.id : boundary.activity.id
    }) : undefined
  };
}
