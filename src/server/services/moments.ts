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
  const activityIds = new Set(activities.map((activity) => activity.id));
  const foldedByActivity = new Map<string, FeedPostView[]>();
  const standalonePosts: FeedPostView[] = [];
  for (const post of posts) {
    // A photo post whose entry is not on this page stays an ordinary post, so it is never hidden.
    if (post.activityId && activityIds.has(post.activityId)) {
      const group = foldedByActivity.get(post.activityId);
      if (group) group.push(post);
      else foldedByActivity.set(post.activityId, [post]);
    } else {
      standalonePosts.push(post);
    }
  }
  const merged: MomentItem[] = [
    ...standalonePosts.map((post): MomentItem => ({ kind: "post", at: post.occurredAt, post })),
    ...activities.map((activity): MomentItem => {
      const own = foldedByActivity.get(activity.id) ?? [];
      return {
        kind: "activity",
        at: activity.occurredAt,
        activity,
        photos: own.flatMap((post) => post.photos),
        photoPostId: own[0]?.id ?? null
      };
    })
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
