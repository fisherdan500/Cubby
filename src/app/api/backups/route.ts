import { ok, handleError } from "@/server/http";
import { listBackupRecords } from "@/server/services/backups";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await listBackupRecords());
  } catch (error) {
    return handleError(error);
  }
}
