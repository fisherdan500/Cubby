import { purgeDueAttachments } from "@/server/services/attachments";
import { sweepStaleBackupUploads } from "@/server/services/backup-upload";

/**
 * One retention pass over private files (DEC-PROD-146): removed attachments past their thirty days,
 * uploads no post claimed within a day, and backup uploads an interrupted restore left behind.
 */
export async function runAttachmentRetention(now = new Date()) {
  const { purged } = await purgeDueAttachments(now);
  const staleUploads = await sweepStaleBackupUploads(now);
  return { purged, staleUploads };
}
