import { handleError, ok } from "@/server/http";
import { updateOwnName } from "@/server/services/own-profile";

export const dynamic = "force-dynamic";

/**
 * Change the caller's own name.
 *
 * No member id in the path, for the same reason the picture route has none: a person changes their
 * own name and nobody else's, so the only account this can touch is the one holding the session.
 */
export async function PATCH(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    return ok(await updateOwnName({ name: body?.name }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleError(error);
  }
}
