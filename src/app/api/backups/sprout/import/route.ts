import { ok, handleError } from "@/server/http";
import { importSproutBackup } from "@/server/services/sprout-import";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    return ok(await importSproutBackup(await request.formData()));
  } catch (error) {
    return handleError(error);
  }
}
