import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listAttachmentObjectKeys,
  readAttachmentObject,
  readAttachmentThumbnail,
  removeAttachmentObject,
  removeAttachmentThumbnail,
  writeAttachmentObject,
  writeAttachmentThumbnail
} from "@/server/services/attachment-store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(name = "cubby-attachments-") {
  const root = await mkdtemp(path.join(os.tmpdir(), name));
  roots.push(root);
  return root;
}

const key = "0123456789abcdef0123456789abcdef";
const bytes = Buffer.from("photo bytes");
const expected = { byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };

describe("attachment store", () => {
  it("writes an object under its storage name and reads back exactly those bytes", async () => {
    const root = await tempRoot();
    await writeAttachmentObject(root, key, bytes, expected);

    await expect(readAttachmentObject(root, key, expected)).resolves.toEqual(bytes);
    // Sharded beneath a fixed objects directory; no temporary files are left behind.
    expect(await readdir(path.join(root, "objects", "01"))).toEqual([key]);
    expect(await listAttachmentObjectKeys(root)).toEqual([key]);
  });

  it("refuses bytes that do not match what it was told to store", async () => {
    const root = await tempRoot();
    await expect(writeAttachmentObject(root, key, bytes, { ...expected, byteSize: 3 })).rejects.toThrow("attachment_store_mismatch");
    expect(await listAttachmentObjectKeys(root)).toEqual([]);
  });

  it("never overwrites an existing object", async () => {
    const root = await tempRoot();
    await writeAttachmentObject(root, key, bytes, expected);
    const other = Buffer.from("different bytes");
    await expect(writeAttachmentObject(root, key, other, { byteSize: other.length, sha256: createHash("sha256").update(other).digest("hex") }))
      .rejects.toThrow("attachment_store_exists");
    await expect(readAttachmentObject(root, key, expected)).resolves.toEqual(bytes);
  });

  it("reports missing and changed bytes rather than serving them", async () => {
    const root = await tempRoot();
    await expect(readAttachmentObject(root, key, expected)).rejects.toThrow("attachment_bytes_missing");

    await writeAttachmentObject(root, key, bytes, expected);
    await writeFile(path.join(root, "objects", "01", key), "tampered!!!");
    await expect(readAttachmentObject(root, key, expected)).rejects.toThrow("attachment_bytes_mismatch");
  });

  it("accepts only its own random storage names, so no path can be reached through one", async () => {
    const root = await tempRoot();
    for (const unsafe of ["../../etc/passwd", "photo.jpg", "0123456789ABCDEF0123456789ABCDEF"]) {
      await expect(writeAttachmentObject(root, unsafe, bytes, expected)).rejects.toThrow("attachment_store_invalid_key");
      await expect(readAttachmentObject(root, unsafe, expected)).rejects.toThrow("attachment_store_invalid_key");
    }
  });

  it("removes an object, and removing it again is harmless", async () => {
    const root = await tempRoot();
    await writeAttachmentObject(root, key, bytes, expected);
    await removeAttachmentObject(root, key);
    await removeAttachmentObject(root, key);
    expect(await listAttachmentObjectKeys(root)).toEqual([]);
  });

  it("ignores stray files when listing, so they are neither served nor mistaken for photos", async () => {
    const root = await tempRoot();
    await writeAttachmentObject(root, key, bytes, expected);
    await writeFile(path.join(root, "objects", "01", "notes.txt"), "stray");
    expect(await listAttachmentObjectKeys(root)).toEqual([key]);
  });

  it("keeps thumbnails in their own directory, apart from the photos the integrity check verifies", async () => {
    const root = await tempRoot();
    await writeAttachmentObject(root, key, bytes, expected);
    const thumbnail = Buffer.from("small jpeg");

    await expect(readAttachmentThumbnail(root, key)).resolves.toBeNull();
    await writeAttachmentThumbnail(root, key, thumbnail);
    // Written twice at once by two viewers: the second finds it already there, and that is fine.
    await writeAttachmentThumbnail(root, key, thumbnail);
    await expect(readAttachmentThumbnail(root, key)).resolves.toEqual(thumbnail);

    expect(await readdir(path.join(root, "thumbnails", "01"))).toEqual([key]);
    expect(await listAttachmentObjectKeys(root)).toEqual([key]);

    await removeAttachmentThumbnail(root, key);
    await removeAttachmentThumbnail(root, key);
    await expect(readAttachmentThumbnail(root, key)).resolves.toBeNull();
    await expect(readAttachmentObject(root, key, expected)).resolves.toEqual(bytes);
    await expect(writeAttachmentThumbnail(root, "../../etc/passwd", thumbnail)).rejects.toThrow("attachment_store_invalid_key");
  });

  it("refuses a storage root reached through a link", async () => {
    const parent = await tempRoot("cubby-attachments-link-");
    const target = path.join(parent, "target");
    const linked = path.join(parent, "linked");
    await mkdir(target);
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");

    await expect(writeAttachmentObject(linked, key, bytes, expected)).rejects.toThrow("attachment_store_unavailable");
    expect(await readdir(target)).toEqual([]);
  });
});
