import { ok, handleError } from "@/server/http";
import { importSproutBackup, normalizeSproutError } from "@/server/services/sprout-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const previewId = formData.get("previewId");
    return ok(await importSproutBackup({ previewId: typeof previewId === "string" ? previewId : undefined }));
  } catch (error) {
    return handleError(normalizeSproutError(error));
  }
}
