import { getActiveTimersForShell } from "@/server/services/active-timers";
import { handleError, ok } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * The running timers for the baby in view, for the app shell's timer bar.
 *
 * The bar asks for these itself rather than every page loading them, which would turn each of the
 * twenty signed-in pages into an activity-reading operation for the sake of one line of chrome.
 */
export async function GET(request: Request) {
  try {
    const babyId = new URL(request.url).searchParams.get("babyId") ?? undefined;
    return ok({ timers: await getActiveTimersForShell(babyId) });
  } catch (error) {
    return handleError(error);
  }
}
