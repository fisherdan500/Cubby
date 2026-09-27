import { HISTORY_PAGE_SIZE } from "@/lib/history-pagination";
import { MOMENTS_QUERY, momentsCursor, parseMomentsCursor } from "@/lib/moments-pagination";
import { listActivities } from "@/server/services/activities";
import { listFeedPosts, type FeedPostView } from "@/server/services/feed-posts";

type ActivityItem = Awaited<ReturnType<typeof listActivities>>[number];
export type MomentItem = { kind: "activity"; at: Date; activity: ActivityItem } | { kind: "post"; at: Date; post: FeedPostView };

/** Each scoped source reads only a page plus lookahead; neither source owns continuation. */
export async function listMixedMoments({ babyId, cursor }: { babyId?: string; cursor?: string }) {
  const after = parseMomentsCursor(cursor);
  const [activities, posts] = await Promise.all([
    listActivities({ babyId, type: undefined, momentsAfter: after, page: MOMENTS_QUERY }),
    listFeedPosts({ babyId, momentsAfter: after, page: MOMENTS_QUERY })
  ]);
  const merged: MomentItem[] = [
    ...posts.map((post): MomentItem => ({ kind: "post", at: post.occurredAt, post })),
    ...activities.map((activity): MomentItem => ({ kind: "activity", at: activity.occurredAt, activity }))
  ];
  // Stable sort retains the database's id order within each source (including its collation).
  merged.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.kind === b.kind ? 0 : a.kind === "post" ? -1 : 1));
  const items = merged.slice(0, HISTORY_PAGE_SIZE);
  const last = items.at(-1);
  return {
    items,
    nextCursor: merged.length > HISTORY_PAGE_SIZE && last ? momentsCursor({
      at: last.at.toISOString(), kind: last.kind, id: last.kind === "post" ? last.post.id : last.activity.id
    }) : undefined
  };
}
