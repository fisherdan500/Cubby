import { ok, handleError } from "@/server/http";
import { importSproutBackup, normalizeSproutError } from "@/server/services/sprout-import";
import { withSproutUpload } from "@/server/services/sprout-upload";

import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requirePermission(await getEffectiveHouseholdContext(), "backup.manage");
    return await withSproutUpload(request, false, async (formData) => {
      const previewId = formData.get("previewId");
      return ok(await importSproutBackup({ previewId: typeof previewId === "string" ? previewId : undefined }));
    });
  } catch (error) {
    return handleError(normalizeSproutError(error));
  }
}
