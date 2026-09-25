import { ok, handleError, isBackupArchiveUpload, readBoundedJson } from "@/server/http";
import { previewBackupArchive, previewBackupJson } from "@/server/services/backups";
import { withUploadedBackupArchive } from "@/server/services/backup-upload";

export const dynamic = "force-dynamic";

/** Preview a JSON backup, or a backup archive with photos (DEC-PROD-422). */
export async function POST(request: Request) {
  try {
    if (isBackupArchiveUpload(request)) return ok(await withUploadedBackupArchive(request, previewBackupArchive));
    return ok(await previewBackupJson(await readBoundedJson(request)));
  } catch (error) {
    return handleError(error);
  }
}
