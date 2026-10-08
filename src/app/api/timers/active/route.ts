import { getActiveTimersForShell } from "@/server/services/active-timers";
import { fail, handleError, ok } from "@/server/http";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * The running timers for the baby in view, for the app shell's timer bar.
 *
 * The bar asks for these itself rather than every page loading them, which would turn each of the
 * twenty signed-in pages into an activity-reading operation for the sake of one line of chrome.
 */
export async function GET(request: Request) {
  try {
    const search = new URL(request.url).searchParams;
    const tokens = search.getAll("requestToken");
    if (tokens.length !== 1 || !z.uuid().safeParse(tokens[0]).success) {
      return fail("invalid_request_token", "Retry the refresh.", 400);
    }
    const requestToken = tokens[0];
    const babyIds = search.getAll("babyId");
    if (babyIds.length > 1 || (babyIds.length === 1 && babyIds[0].length === 0)) {
      return fail("invalid_baby_id", "Select a valid baby.", 400);
    }
    const babyId = babyIds[0];
    const timers = await getActiveTimersForShell(babyId);
    return ok({ timers, confirmedAt: new Date().toISOString(), requestToken }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleError(error);
  }
}
