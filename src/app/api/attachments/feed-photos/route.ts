import { attachmentPolicy } from "@/domain/attachments";
import { handleError, ok, readBoundedBytes } from "@/server/http";
import { stageFeedPhoto } from "@/server/services/attachments";

export const dynamic = "force-dynamic";

/**
 * Upload one photo for a post that has not been shared yet. The photo is re-saved and stored, but
 * nobody sees it until a post claims it; unclaimed uploads are cleared away after a day.
 */
export async function POST(request: Request) {
  try {
    const upload = await readBoundedBytes(request, attachmentPolicy.feed_photo.maxInputBytes, "attachment_too_large");
    const staged = await stageFeedPhoto(upload);
    return ok(staged, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleError(error);
  }
}
