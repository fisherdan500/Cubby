import { ok, handleError, readBoundedJson } from "@/server/http";
import { previewBackupJson } from "@/server/services/backups";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    return ok(await previewBackupJson(await readBoundedJson(request)));
  } catch (error) {
    return handleError(error);
  }
}
