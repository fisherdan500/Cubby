import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupArchiveStream, openBackupArchive } from "@/server/services/backup-archive";
import { createV2Backup } from "@/server/services/backup-format";
import { zipStoreStream } from "@/server/services/zip-store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function saved(stream: ReadableStream<Uint8Array>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cubby-backup-archive-"));
  roots.push(root);
  const file = path.join(root, "backup.zip");
  await writeFile(file, Buffer.from(await new Response(stream).arrayBuffer()));
  return file;
}

const bytesA = Buffer.from("first photo bytes");
const bytesB = Buffer.from("second photo bytes!");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const photo = (id: string, bytes: Buffer, position: number) => ({
  id, postId: "post-1", position, width: 800, height: 600, byteSize: bytes.length, sha256: digest(bytes)
});

function backup() {
  return createV2Backup({
    household: { name: "Home" }, settings: {}, babies: [], contacts: [], catalogs: [], activities: [], calendarEvents: [], reminders: [],
    feedPosts: [{ id: "post-1", babyId: null, body: "", tags: [], occurredAt: "2026-09-29T10:00:00.000Z", authorName: "Sam" }],
    feedPhotos: [photo("ph-a", bytesA, 0), photo("ph-b", bytesB, 1)]
  }, "2026-09-30T10:00:00.000Z");
}

const readers = { "ph-a": bytesA, "ph-b": bytesB } as Record<string, Buffer>;

describe("backup archives", () => {
  it("carries backup.json and every listed photo, and reads back verified", async () => {
    const snapshot = backup();
    const readPhoto = vi.fn(async (photoId: string) => readers[photoId]!);
    const file = await saved(backupArchiveStream(snapshot, readPhoto));

    const archive = await openBackupArchive(file);
    try {
      expect(archive.parsed.backup.checksum).toBe(snapshot.checksum);
      expect(await archive.readPhoto("ph-b")).toEqual(bytesB);
      await expect(archive.verifyPhotos()).resolves.toBe(2);
    } finally {
      await archive.close();
    }
    expect(readPhoto.mock.calls.map(([photoId]) => photoId)).toEqual(["ph-a", "ph-b"]);
  });

  it("refuses an archive missing a listed photo, carrying an unlisted file, or holding changed bytes", async () => {
    const snapshot = backup();
    const json = Buffer.from(JSON.stringify(snapshot));
    async function* files(list: Array<[string, Buffer]>) {
      for (const [name, data] of list) yield { name, data };
    }

    const missing = await saved(zipStoreStream(files([["backup.json", json], ["photos/ph-a.jpg", bytesA]])));
    await expect(openBackupArchive(missing)).rejects.toThrow("backup_invalid");

    const extra = await saved(zipStoreStream(files([["backup.json", json], ["photos/ph-a.jpg", bytesA], ["photos/ph-b.jpg", bytesB], ["notes.txt", Buffer.from("x")]])));
    await expect(openBackupArchive(extra)).rejects.toThrow("backup_invalid");

    const changed = await saved(zipStoreStream(files([["backup.json", json], ["photos/ph-a.jpg", bytesA], ["photos/ph-b.jpg", Buffer.from("second photo bytes?")]])));
    const archive = await openBackupArchive(changed);
    await expect(archive.verifyPhotos()).rejects.toThrow("backup_photo_mismatch");
    await archive.close();
  });

  it("refuses an archive whose backup.json is damaged or missing", async () => {
    async function* files(list: Array<[string, Buffer]>) {
      for (const [name, data] of list) yield { name, data };
    }
    const tampered = { ...backup(), payload: { ...backup().payload, household: { name: "Elsewhere" } } };
    const bad = await saved(zipStoreStream(files([["backup.json", Buffer.from(JSON.stringify(tampered))], ["photos/ph-a.jpg", bytesA], ["photos/ph-b.jpg", bytesB]])));
    await expect(openBackupArchive(bad)).rejects.toThrow("backup_checksum_mismatch");

    const none = await saved(zipStoreStream(files([["photos/ph-a.jpg", bytesA]])));
    await expect(openBackupArchive(none)).rejects.toThrow("backup_invalid");

    const notZip = await saved(new Response("{}").body!);
    await expect(openBackupArchive(notZip)).rejects.toThrow("backup_invalid");
  });

  it("stops writing if a photo's bytes cannot be read, rather than finishing an incomplete backup", async () => {
    const snapshot = backup();
    const stream = backupArchiveStream(snapshot, async (photoId) => {
      if (photoId === "ph-b") throw new Error("attachment_bytes_mismatch");
      return readers[photoId]!;
    });
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow();
  });
});
