import { ok, handleError } from "@/server/http";
import { previewSproutBackup, normalizeSproutError } from "@/server/services/sprout-import";
import { withSproutUpload } from "@/server/services/sprout-upload";

import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requirePermission(await getEffectiveHouseholdContext(), "backup.manage");
    return await withSproutUpload(request, true, async (form) => ok(await previewSproutBackup(form)));
  } catch (error) {
    return handleError(normalizeSproutError(error));
  }
}
