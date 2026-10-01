/**
 * How posts and logged entries become one list of moments.
 *
 * A photo added to a logged entry is stored as an ordinary feed photo on a real post. That is
 * deliberate: private delivery and the backup export both select feed photos through their parent
 * post, so a photo with no post would be unreachable and would silently travel in no backup.
 *
 * The family should still see one moment rather than an entry and its photo side by side, so a post
 * that belongs to an entry is folded into that entry here, at presentation time only. The post
 * remains the photo's owner in the database.
 */

type PhotoRef = { id: string };  // width/height travel with it in the real view

type PostLike = {
  id: string;
  occurredAt: Date;
  activityId: string | null;
  photos: readonly PhotoRef[];
};

type ActivityLike = { id: string; occurredAt: Date };

export type MomentItem<P extends PostLike, A extends ActivityLike> =
  | { kind: "post"; at: Date; post: P }
  | {
      kind: "activity";
      at: Date;
      activity: A;
      /** Photos from the entry's own photo posts, in the order those posts were made. */
      photos: readonly PhotoRef[];
      /** The post that owns the photos, kept so delivery and backup still see a parent post. */
      photoPostId: string | null;
    };

/**
 * Merge posts and entries into one newest-first list, folding each photo post into the entry it
 * belongs to.
 */
export function mergeMomentItems<P extends PostLike, A extends ActivityLike>(input: {
  posts: readonly P[];
  activities: readonly A[];
}): MomentItem<P, A>[] {
  const activityIds = new Set(input.activities.map((activity) => activity.id));

  // A photo post whose entry is not in this page stays an ordinary post, so it is never hidden.
  const folded = new Map<string, P[]>();
  const standalone: P[] = [];
  for (const post of input.posts) {
    if (post.activityId && activityIds.has(post.activityId)) {
      const group = folded.get(post.activityId);
      if (group) group.push(post);
      else folded.set(post.activityId, [post]);
    } else {
      standalone.push(post);
    }
  }

  const items: MomentItem<P, A>[] = [
    ...standalone.map((post): MomentItem<P, A> => ({ kind: "post", at: post.occurredAt, post })),
    ...input.activities.map((activity): MomentItem<P, A> => {
      const group = (folded.get(activity.id) ?? []).slice().sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
      return {
        kind: "activity",
        at: activity.occurredAt,
        activity,
        photos: group.flatMap((post) => post.photos),
        photoPostId: group[0]?.id ?? null
      };
    })
  ];

  return items.sort((a, b) => b.at.getTime() - a.at.getTime());
}
