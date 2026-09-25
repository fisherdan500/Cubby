import { constants as fsConstants } from "node:fs";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import path from "node:path";
import { attachmentConfig } from "@/lib/env";
import { MAX_BACKUP_ARCHIVE_BYTES } from "@/server/services/backup-archive";

/**
 * Uploaded backup archives are written to a private staging directory beside the photo store - never
 * held whole in memory - read from there, and removed as soon as the preview or restore is done.
 */

const STAGING = "restore-staging";
const STALE_MS = 24 * 60 * 60 * 1000;

async function stagingDirectory() {
  const directory = path.join(path.resolve(attachmentConfig.directory), STAGING);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("attachment_store_unavailable");
  return directory;
}

export async function withUploadedBackupArchive<T>(
  request: Request,
  work: (filePath: string) => Promise<T>,
  options: { maxBytes?: number } = {}
): Promise<T> {
  const maxBytes = options.maxBytes ?? MAX_BACKUP_ARCHIVE_BYTES;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("archive_too_large");
  if (!request.body) throw new Error("backup_invalid");

  const filePath = path.join(await stagingDirectory(), `${randomBytes(16).toString("hex")}.zip`);
  const file = await open(filePath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    try {
      const reader = request.body.getReader();
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("archive_too_large");
        }
        await file.write(value);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    return await work(filePath);
  } finally {
    await unlink(filePath).catch(() => undefined);
  }
}

/** Remove uploads a crash or restart left behind. Returns how many were removed. */
export async function sweepStaleBackupUploads(now = new Date()) {
  let directory: string;
  try {
    directory = await stagingDirectory();
  } catch {
    return 0;
  }
  let removed = 0;
  for await (const entry of await opendir(directory)) {
    // Only this module's own upload names; anything else in the directory is left alone.
    if (!entry.isFile() || !/^[a-f0-9]{32}\.zip$/.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const stats = await lstat(filePath).catch(() => null);
    if (stats && now.getTime() - stats.mtimeMs >= STALE_MS) {
      await unlink(filePath).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}
