/**
 * The responses belonging to one logged entry.
 *
 * Comments on an entry already exist and already appear in Moments; this is only how the entry's own
 * screen asks for its share of them. One entry, so one activity and no posts: the entry screen must
 * not pull the whole feed's interactions to show a single thread.
 */

/**
 * The interaction query for a single logged entry.
 */
export function activityResponsesQuery(activityId: string): { postIds: string[]; activityIds: string[] } {
  return { postIds: [], activityIds: [activityId] };
}
