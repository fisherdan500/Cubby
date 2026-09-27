import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import sharp from "sharp";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const faults = vi.hoisted(() => ({ openCode: "" }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    if (faults.openCode) throw Object.assign(new Error("synthetic read failure"), { code: faults.openCode });
    return fs.open(...args);
  } };
});
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
  faults.openCode = "";
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
  it("removes only the exact new owned temporary name as well as the final object", async () => {
    const root = await tempRoot();
    await writeAttachmentObject(root, key, bytes, expected);
    const shard = path.join(root, "objects", "01");
    await writeFile(path.join(shard, `.${key}.write-v1.tmp`), bytes);
    await writeFile(path.join(shard, `.${key}.legacy.tmp`), bytes);
    await removeAttachmentObject(root, key);
    expect(await readdir(shard)).toEqual([`.${key}.legacy.tmp`]);
  });
  it.each(["EACCES", "EMFILE", "EIO"])("classifies %s as retryable infrastructure failure, not missing bytes", async (code) => {
    const root = await tempRoot();
    await writeAttachmentObject(root, key, bytes, expected);
    faults.openCode = code;
    await expect(readAttachmentObject(root, key, expected)).rejects.toThrow("attachment_store_unavailable");
    faults.openCode = "";
    await expect(readAttachmentObject(root, key, expected)).resolves.toEqual(bytes);
  });

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
    const thumbnail = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).jpeg().toBuffer();

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

  it.each(["empty", "truncated", "truncated-pixels", "wrong-format", "oversized-dimensions"])("repairs a %s cache persistently without changing the original", async (kind) => {
    const root = await tempRoot();
    await writeAttachmentObject(root, key, bytes, expected);
    const thumbnail = await sharp({ create: { width: 16, height: 16, channels: 3, background: "red" } }).jpeg().toBuffer();
    await writeAttachmentThumbnail(root, key, thumbnail);
    const corrupt = kind === "empty" ? Buffer.alloc(0)
      : kind === "truncated" ? thumbnail.subarray(0, thumbnail.length - 2)
      : kind === "truncated-pixels" ? Buffer.concat([thumbnail.subarray(0, thumbnail.length - 5), thumbnail.subarray(-2)])
      : await sharp({ create: { width: kind === "oversized-dimensions" ? 801 : 16, height: 16, channels: 3, background: "blue" } })
        .toFormat(kind === "wrong-format" ? "png" : "jpeg").toBuffer();
    if (kind.startsWith("truncated")) expect((await sharp(corrupt).metadata()).format).toBe("jpeg");
    await writeFile(path.join(root, "thumbnails", "01", key), corrupt);
    expect(await readAttachmentThumbnail(root, key)).toBeNull();
    // Repeated validation must not inherit a native cached load that lost its warnings.
    expect(await readAttachmentThumbnail(root, key)).toBeNull();
    await writeAttachmentThumbnail(root, key, thumbnail);
    expect(await readAttachmentThumbnail(root, key)).toEqual(thumbnail);
    expect(await readAttachmentThumbnail(root, key)).toEqual(thumbnail);
    expect(await readAttachmentObject(root, key, expected)).toEqual(bytes);
    expect(await readdir(path.join(root, "thumbnails", "01"))).toEqual([key]);
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
