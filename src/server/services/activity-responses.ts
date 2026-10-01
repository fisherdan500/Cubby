/**
 * The responses belonging to one logged entry.
 *
 * Comments on an entry already exist and already appear in Moments; this is only how the entry's own
 * screen asks for its share of them. One entry, so one activity and no posts: the entry screen must
 * not pull the whole feed's interactions to show a single thread.
 */
import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext } from "@/server/auth/context";

/**
 * The interaction query for a single logged entry.
 */
export function activityResponsesQuery(activityId: string): { postIds: string[]; activityIds: string[] } {
  return { postIds: [], activityIds: [activityId] };
}

/**
 * The photos belonging to one logged entry.
 *
 * An entry's photos live on the entry's own photo posts, which is what keeps each one an ordinary
 * feed photo with a real parent -- the property private delivery and the backup export both rely on.
 * Scoped to the caller's household as well as the entry, so no query can reach across households
 * even if an entry id leaks.
 */
export async function listActivityPhotos(
  activityId: string
): Promise<{ id: string; width: number; height: number }[]> {
  const ctx = await getEffectiveHouseholdContext();
  const posts = await prisma.feedPost.findMany({
    where: { householdId: ctx.householdId, activityId, deletedAt: null },
    // Oldest first, so the pictures read in the order they were added.
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      photos: {
        where: { state: "available" },
        orderBy: { position: "asc" },
        select: { id: true, width: true, height: true }
      }
    }
  });
  return posts.flatMap((post) => post.photos);
}
