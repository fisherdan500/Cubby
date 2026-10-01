import { attachmentPolicy } from "@/domain/attachments";
import { handleError, ok, readBoundedBytes } from "@/server/http";
import { stageUserPhoto } from "@/server/services/attachments";
import { withPhotoUploadAdmission } from "@/server/services/photo-upload";

import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";

export const dynamic = "force-dynamic";

/**
 * Upload one profile picture. It is stored but belongs to nobody until a claim attaches it to the
 * caller's own membership; unclaimed uploads are cleared away after a day.
 *
 * Gated on session.manage, which every role has, because setting your own picture is self-service:
 * a caretaker may change their own face without being allowed to administer the household. The
 * permission is checked before the body is read, so an unauthorised caller cannot push bytes
 * through the server first.
 */
export async function POST(request: Request) {
  try {
    requirePermission(await getEffectiveHouseholdContext(), "session.manage");
    return await withPhotoUploadAdmission(async () => {
      const upload = await readBoundedBytes(request, attachmentPolicy.user_photo.maxInputBytes, "attachment_too_large");
      const staged = await stageUserPhoto(upload);
      return ok(staged, { status: 201, headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    return handleError(error);
  }
}
