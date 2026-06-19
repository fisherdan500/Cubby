import { ok, handleError } from "@/server/http";
import { previewSproutBackup } from "@/server/services/sprout-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    return ok(await previewSproutBackup(await request.formData()));
  } catch (error) {
    return handleError(error);
  }
}
