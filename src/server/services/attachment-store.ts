import { constants as fsConstants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, opendir, unlink } from "node:fs/promises";
import path from "node:path";
import { attachmentPolicy, isAttachmentStorageKey } from "@/domain/attachments";

/**
 * The private byte store for attachments (DEC-PROD-142, DEC-PROD-143). Objects live beneath a fixed
 * `objects` directory under server-generated random names, never under anything a person supplied.
 * A write lands in a temporary file, is synced, and is then linked into place without overwriting, so
 * an object either exists whole or not at all. Every read checks size and checksum against what the
 * database recorded, so changed or damaged bytes are reported rather than served.
 */

const OBJECTS = "objects";
const MAX_OBJECT_BYTES = attachmentPolicy.feed_photo.maxInputBytes;

type Expected = { byteSize: number; sha256: string };

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function assertKey(key: string) {
  if (!isAttachmentStorageKey(key)) throw new Error("attachment_store_invalid_key");
}

/** Every component of the root must be a real directory: a link could redirect the store elsewhere. */
async function trustedRoot(root: string, create: boolean) {
  const resolved = path.resolve(root);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) throw new Error("attachment_store_unavailable");
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("attachment_store_unavailable");
    } catch (error) {
      if (!isMissing(error)) throw new Error("attachment_store_unavailable");
      if (!create) throw error;
      await mkdir(current, { mode: 0o700 }).catch((mkdirError: unknown) => {
        if (!(mkdirError && typeof mkdirError === "object" && "code" in mkdirError && mkdirError.code === "EEXIST")) throw mkdirError;
      });
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("attachment_store_unavailable");
    }
  }
  return resolved;
}

async function objectDirectory(root: string, key: string, create: boolean) {
  const base = await trustedRoot(root, create);
  const directory = path.join(base, OBJECTS, key.slice(0, 2));
  for (const part of [path.join(base, OBJECTS), directory]) {
    try {
      const stats = await lstat(part);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("attachment_store_unavailable");
    } catch (error) {
      if (!isMissing(error) || !create) throw error;
      await mkdir(part, { mode: 0o700 }).catch((mkdirError: unknown) => {
        if (!(mkdirError && typeof mkdirError === "object" && "code" in mkdirError && mkdirError.code === "EEXIST")) throw mkdirError;
      });
    }
  }
  return directory;
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function syncDirectory(directory: string) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    // Windows cannot sync a directory handle; the file itself was synced before linking.
    if (!["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Store `bytes` as `key`, once. Fails if the bytes differ from `expected` or the name is taken. */
export async function writeAttachmentObject(root: string, key: string, bytes: Buffer, expected: Expected) {
  assertKey(key);
  if (bytes.length !== expected.byteSize || sha256(bytes) !== expected.sha256) throw new Error("attachment_store_mismatch");
  let directory: string;
  try {
    directory = await objectDirectory(root, key, true);
  } catch {
    throw new Error("attachment_store_unavailable");
  }
  const finalPath = path.join(directory, key);
  const tempPath = path.join(directory, `.${key}.${randomBytes(8).toString("hex")}.tmp`);
  let file;
  try {
    file = await open(tempPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = undefined;
    await link(tempPath, finalPath);
    await unlink(tempPath);
    await syncDirectory(directory);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error("attachment_store_exists");
    throw new Error("attachment_store_write_failed");
  }
  // Read it back through the same check every later read makes.
  await readAttachmentObject(root, key, expected);
}

/** The stored bytes for `key`, only if they are exactly what the database recorded. */
export async function readAttachmentObject(root: string, key: string, expected: Expected) {
  assertKey(key);
  let handle;
  try {
    const directory = await objectDirectory(root, key, false);
    const filePath = path.join(directory, key);
    const before = await lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("attachment_bytes_mismatch");
    handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (stats.dev !== before.dev || stats.ino !== before.ino) throw new Error("attachment_bytes_mismatch");
    if (stats.size !== expected.byteSize || stats.size > MAX_OBJECT_BYTES) throw new Error("attachment_bytes_mismatch");
    const bytes = await handle.readFile();
    if (bytes.length !== expected.byteSize || sha256(bytes) !== expected.sha256) throw new Error("attachment_bytes_mismatch");
    return bytes;
  } catch (error) {
    if (isMissing(error)) throw new Error("attachment_bytes_missing");
    if (error instanceof Error && error.message === "attachment_bytes_mismatch") throw error;
    if (error instanceof Error && error.message === "attachment_store_unavailable") throw error;
    throw new Error("attachment_bytes_missing");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Remove the object for `key`. Removing one that is already gone succeeds. */
export async function removeAttachmentObject(root: string, key: string) {
  assertKey(key);
  let directory: string;
  try {
    directory = await objectDirectory(root, key, false);
  } catch (error) {
    if (isMissing(error)) return;
    throw new Error("attachment_store_unavailable");
  }
  try {
    await unlink(path.join(directory, key));
    await syncDirectory(directory);
  } catch (error) {
    if (!isMissing(error)) throw new Error("attachment_store_write_failed");
  }
}

/** Every stored object's name, for the integrity check. Anything not named like an object is skipped. */
export async function listAttachmentObjectKeys(root: string) {
  let base: string;
  try {
    base = await trustedRoot(root, false);
  } catch (error) {
    if (isMissing(error)) return [];
    throw new Error("attachment_store_unavailable");
  }
  const keys: string[] = [];
  let shards;
  try {
    shards = await opendir(path.join(base, OBJECTS));
  } catch (error) {
    if (isMissing(error)) return [];
    throw new Error("attachment_store_unavailable");
  }
  for await (const shard of shards) {
    if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
    for await (const entry of await opendir(path.join(base, OBJECTS, shard.name))) {
      if (entry.isFile() && isAttachmentStorageKey(entry.name) && entry.name.startsWith(shard.name)) keys.push(entry.name);
    }
  }
  return keys.sort();
}
