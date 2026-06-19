import { ok, handleError } from "@/server/http";
import { restoreBackupJson } from "@/server/services/backups";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    return ok(await restoreBackupJson(await request.json()));
  } catch (error) {
    return handleError(error);
  }
}
