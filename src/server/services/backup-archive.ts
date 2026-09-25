import { createHash } from "node:crypto";
import { MAX_BACKUP_BYTES, feedPhotoArchiveName, parseBackup, type ParsedBackup } from "@/server/services/backup-format";
import { openZipStore, zipStoreStream, type ZipEntry } from "@/server/services/zip-store";

/**
 * A household backup with photos (DEC-PROD-422): one uncompressed ZIP holding backup.json - the
 * ordinary version 2 backup, whose checksum covers every photo's size and digest - and each photo as
 * photos/<id>.jpg. Nothing else may be in it, nothing listed may be missing, and every photo must
 * match its digest before a restore relies on it (DEC-PROD-142, DEC-PROD-145).
 */

export const BACKUP_JSON_NAME = "backup.json";
export const MAX_BACKUP_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

type V2Backup = Extract<ParsedBackup, { version: 2 }>["backup"];
type FeedPhoto = NonNullable<V2Backup["payload"]["feedPhotos"]>[number];

/** Stream a backup and its photos; `readPhoto` returns each photo's verified bytes. */
export function backupArchiveStream(snapshot: V2Backup, readPhoto: (photoId: string, photo: FeedPhoto) => Promise<Buffer>) {
  async function* entries(): AsyncGenerator<ZipEntry> {
    yield { name: BACKUP_JSON_NAME, data: Buffer.from(JSON.stringify(snapshot, null, 2), "utf8") };
    for (const photo of snapshot.payload.feedPhotos ?? []) {
      yield { name: feedPhotoArchiveName(photo.id), data: await readPhoto(photo.id, photo) };
    }
  }
  return zipStoreStream(entries());
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

export type OpenedBackupArchive = {
  parsed: Extract<ParsedBackup, { version: 2 }>;
  photos: FeedPhoto[];
  /** One photo's bytes, checked against its listed size and digest. */
  readPhoto(photoId: string): Promise<Buffer>;
  /** Check every photo; resolves to how many there are. */
  verifyPhotos(): Promise<number>;
  close(): Promise<void>;
};

/** Open an uploaded backup archive. Its layout and backup.json are checked here; photos on demand. */
export async function openBackupArchive(filePath: string): Promise<OpenedBackupArchive> {
  let zip;
  try {
    zip = await openZipStore(filePath, { maxEntries: 60_001 });
  } catch {
    throw new Error("backup_invalid");
  }
  try {
    const names = new Set(zip.names());
    if (!names.has(BACKUP_JSON_NAME)) throw new Error("backup_invalid");
    let raw: unknown;
    try {
      raw = JSON.parse((await zip.read(BACKUP_JSON_NAME, MAX_BACKUP_BYTES)).toString("utf8"));
    } catch {
      throw new Error("backup_invalid");
    }
    let parsed: ParsedBackup;
    try {
      parsed = parseBackup(raw);
    } catch (error) {
      if (error instanceof Error && error.message === "backup_checksum_mismatch") throw error;
      throw new Error("backup_invalid");
    }
    if (parsed.version !== 2) throw new Error("backup_invalid");
    const photos = parsed.backup.payload.feedPhotos ?? [];
    const expected = new Set([BACKUP_JSON_NAME, ...photos.map((photo) => feedPhotoArchiveName(photo.id))]);
    if (names.size !== expected.size || [...names].some((name) => !expected.has(name))) throw new Error("backup_invalid");
    const byId = new Map(photos.map((photo) => [photo.id, photo]));
    const opened = zip;

    const readPhoto = async (photoId: string) => {
      const photo = byId.get(photoId);
      if (!photo) throw new Error("backup_invalid");
      let bytes: Buffer;
      try {
        bytes = await opened.read(feedPhotoArchiveName(photo.id), photo.byteSize);
      } catch {
        throw new Error("backup_photo_mismatch");
      }
      if (bytes.length !== photo.byteSize || sha256(bytes) !== photo.sha256) throw new Error("backup_photo_mismatch");
      return bytes;
    };

    return {
      parsed,
      photos,
      readPhoto,
      async verifyPhotos() {
        for (const photo of photos) await readPhoto(photo.id);
        return photos.length;
      },
      close: () => opened.close()
    };
  } catch (error) {
    await zip.close().catch(() => undefined);
    throw error;
  }
}
