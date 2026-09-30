import { fail, handleError, ok } from "@/server/http";
import { claimStagedBabyPhoto } from "@/server/services/attachments";

import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";

export const dynamic = "force-dynamic";

/**
 * Make an already-uploaded picture this baby's profile picture.
 *
 * The baby is identified by the path, never by the request body: a body-supplied id would let a
 * caller aim the claim at a baby outside their own household. The household itself comes from the
 * session, and the service re-checks ownership in the database before anything is written.
 */
export async function PUT(request: Request, { params }: { params: { id: string } }) {
  try {
    requirePermission(await getEffectiveHouseholdContext(), "baby.manage");
    const raw = await request.json() as Record<string, unknown>;
    if (typeof raw.attachmentId !== "string" || raw.attachmentId.length === 0) {
      return fail("invalid_request", "Choose a picture to use.");
    }
    return ok(await claimStagedBabyPhoto(raw.attachmentId, params.id));
  } catch (error) {
    return handleError(error);
  }
}
