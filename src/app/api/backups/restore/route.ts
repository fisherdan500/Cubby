import { ok, handleError, readBoundedJson } from "@/server/http";
import { restoreBackupJson } from "@/server/services/backups";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
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
    return ok(await restoreBackupJson(await readBoundedJson(request), { confirmation, previewChecksum }));
  } catch (error) {
    return handleError(error);
  }
}
