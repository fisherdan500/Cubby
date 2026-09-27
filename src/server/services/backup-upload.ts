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

// A full-size reservation, independent of caller-controlled Content-Length. Shared by route bundles.
const admission = globalThis as typeof globalThis & { cubbyBackupUploadActive?: boolean; cubbyBackupUploadCleanupFailed?: boolean };

export async function withBackupUploadAdmission<T>(work: () => Promise<T>): Promise<T> {
  if (admission.cubbyBackupUploadActive) throw new Error("backup_upload_busy");
  admission.cubbyBackupUploadActive = true;
  try {
    return await work();
  } finally {
    if (!admission.cubbyBackupUploadCleanupFailed) admission.cubbyBackupUploadActive = false;
  }
}

export async function withUploadedBackupArchive<T>(
  request: Request,
  work: (filePath: string) => Promise<T>,
  options: { maxBytes?: number } = {}
): Promise<T> {
  return withBackupUploadAdmission(() => stageBackupArchive(request, work, options));
}

async function stageBackupArchive<T>(
  request: Request,
  work: (filePath: string) => Promise<T>,
  options: { maxBytes?: number } = {}
): Promise<T> {
  const maxBytes = options.maxBytes ?? MAX_BACKUP_ARCHIVE_BYTES;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("archive_too_large");
  if (!request.body) throw new Error("backup_invalid");

  if (request.signal.aborted) throw new Error("backup_upload_aborted");
  const directory = await stagingDirectory();
  // Every leftover consumes the full slot after restart, even a zero-byte/unknown entry.
  // Do not adopt or delete it here. This keeps the next full-size reservation honest.
  const entries = await opendir(directory);
  try {
    if (await entries.read()) throw new Error("backup_upload_busy");
  } finally {
    await entries.close();
  }
  if (request.signal.aborted) throw new Error("backup_upload_aborted");
  const reader = request.body.getReader();
  let failure: Error | undefined;
  let cancellation: Promise<void> | undefined;
  const stop = (code: string) => {
    failure ??= new Error(code);
    cancellation ??= reader.cancel(failure).catch(() => undefined);
  };
  const onAbort = () => stop("backup_upload_aborted");
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("backup_upload_timeout"), 120_000);
  const check = () => { if (failure) throw failure; };
  let filePath: string | undefined;
  try {
    try {
      check();
      const candidate = path.join(directory, `${randomBytes(16).toString("hex")}.zip`);
      const file = await open(candidate, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      filePath = candidate;
      try {
        let total = 0;
        while (true) {
          check();
          const { done, value } = await reader.read();
          check();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) throw new Error("archive_too_large");
          // Await disk operations even after cancellation: never release admission over orphaned I/O.
          await file.writeFile(value);
        }
        await file.sync();
        check();
      } finally {
        await file.close();
      }
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      await (cancellation ?? reader.cancel().catch(() => undefined));
      reader.releaseLock();
    }
    return await work(filePath);
  } finally {
    if (filePath) await unlink(filePath).catch(() => {
      admission.cubbyBackupUploadCleanupFailed = true;
      throw new Error("attachment_store_unavailable");
    });
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
