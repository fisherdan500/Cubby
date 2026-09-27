import { ok, handleError, isBackupArchiveUpload, readBoundedJson } from "@/server/http";
import { restoreBackupArchive, restoreBackupJson } from "@/server/services/backups";
import { withUploadedBackupArchive, withBackupUploadAdmission } from "@/server/services/backup-upload";

import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requirePermission(await getEffectiveHouseholdContext(), "backup.manage");
    const encodedConfirmation = request.headers.get("x-cubby-restore-confirmation") ?? undefined;
    const previewChecksum = request.headers.get("x-cubby-backup-checksum") ?? undefined;
    if (!encodedConfirmation) throw new Error("backup_confirmation_mismatch");
    if (!previewChecksum) throw new Error("backup_preview_mismatch");
    let confirmation: string;
    try {
      confirmation = decodeURIComponent(encodedConfirmation);
    } catch {
      throw new Error("backup_confirmation_mismatch");
    }
    if (isBackupArchiveUpload(request)) {
      return ok(await withUploadedBackupArchive(request, (filePath) => restoreBackupArchive(filePath, { confirmation, previewChecksum })));
    }
    return ok(await withBackupUploadAdmission(async () => restoreBackupJson(await readBoundedJson(request), { confirmation, previewChecksum })));
  } catch (error) {
    return handleError(error);
  }
}
