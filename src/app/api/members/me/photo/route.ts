import { handleError, ok } from "@/server/http";
import { claimStagedUserPhoto } from "@/server/services/attachments";

export const dynamic = "force-dynamic";

/**
 * Make an uploaded picture the caller's own profile picture.
 *
 * There is no member id in the path on purpose: a member sets their own picture and nobody else's,
 * so the only membership this can touch is the caller's. The service re-checks that the membership
 * is still live inside the transaction, and retires whichever picture it replaces.
 */
export async function PUT(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { attachmentId?: unknown } | null;
    const attachmentId = typeof body?.attachmentId === "string" ? body.attachmentId : "";
    if (!attachmentId) throw new Error("attachment_not_found");
    const claimed = await claimStagedUserPhoto(attachmentId);
    return ok(claimed, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleError(error);
  }
}
