import { handleError, ok } from "@/server/http";
import { countUnseenMoments } from "@/server/services/moments-seen";

export const dynamic = "force-dynamic";

/**
 * How many moments arrived since this member last looked, for the badge over the Moments tab.
 *
 * The badge asks for this itself rather than every page's loader computing it, which would turn
 * each of the twenty signed-in pages into a feed-reading operation for the sake of one dot. Same
 * shape as the timer bar's /api/timers/active. Content-free: a count, never titles or bodies.
 */
export async function GET() {
  try {
    const unseen = await countUnseenMoments();
    return ok({ unseen }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleError(error);
  }
}
