import { attachmentPolicy } from "@/domain/attachments";
import { handleError, ok, readBoundedBytes } from "@/server/http";
import { stageBabyPhoto } from "@/server/services/attachments";
import { withPhotoUploadAdmission } from "@/server/services/photo-upload";

import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";

export const dynamic = "force-dynamic";

/**
 * Upload one picture for a baby. The picture is re-saved and stored, but it is nobody's profile
 * picture until a claim points it at a baby; unclaimed uploads are cleared away after a day.
 *
 * Gated on baby.manage rather than feed.post: a caretaker may post photos to the feed without being
 * allowed to change a child's identity picture. The permission is checked before the body is read
 * so an unauthorised caller cannot push bytes through the server first.
 */
export async function POST(request: Request) {
  try {
    requirePermission(await getEffectiveHouseholdContext(), "baby.manage");
    return await withPhotoUploadAdmission(async () => {
      const upload = await readBoundedBytes(request, attachmentPolicy.baby_photo.maxInputBytes, "attachment_too_large");
      const staged = await stageBabyPhoto(upload);
      return ok(staged, { status: 201, headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return handleError(error);
  }
}
