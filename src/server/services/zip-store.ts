import { open, type FileHandle } from "node:fs/promises";
import { crc32 } from "node:zlib";

/**
 * Plain, uncompressed ZIP archives for household backups with photos (DEC-PROD-422). Photos are
 * already compressed, so nothing is gained by deflating them, and refusing compression means an
 * uploaded archive is never fed to a decompressor. Written as a stream and read by random access
 * from a file, so neither side holds a whole archive in memory. No ZIP64: an archive stays under
 * 4 GiB and 65,535 entries, and anything that needs more is refused rather than misread.
 */

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_NAMES = 0x0800;
const ENCRYPTED = 0x0001;
const VERSION = 20;
// A fixed timestamp (1980-01-01) keeps the same content producing the same archive.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const MAX_OFFSET = 0xffffffff;
const MAX_ENTRIES = 0xffff;
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;

// Relative names of plain segments only: no "..", ".", empty segments, backslashes or drive letters.
const SAFE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

function invalid(): never {
  throw new Error("archive_invalid");
}

export function isSafeArchiveName(name: string) {
  return name.length > 0 && name.length <= 255 && SAFE_NAME.test(name);
}

export type ZipEntry = { name: string; data: Buffer };

/** Stream `entries` out as an uncompressed ZIP archive. */
export function zipStoreStream(entries: AsyncIterable<ZipEntry>): ReadableStream<Uint8Array> {
  const iterator = entries[Symbol.asyncIterator]();
  const central: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let finished = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        const next = await iterator.next();
        if (!next.done) {
          const { name, data } = next.value;
          if (!isSafeArchiveName(name) || seen.has(name) || seen.size >= MAX_ENTRIES) invalid();
          seen.add(name);
          const nameBytes = Buffer.from(name, "utf8");
          const checksum = crc32(data);
          if (offset + 30 + nameBytes.length + data.length > MAX_OFFSET) throw new Error("archive_too_large");

          const local = Buffer.alloc(30);
          local.writeUInt32LE(LOCAL_HEADER, 0);
          local.writeUInt16LE(VERSION, 4);
          local.writeUInt16LE(UTF8_NAMES, 6);
          local.writeUInt16LE(0, 8);
          local.writeUInt16LE(DOS_TIME, 10);
          local.writeUInt16LE(DOS_DATE, 12);
          local.writeUInt32LE(checksum, 14);
          local.writeUInt32LE(data.length, 18);
          local.writeUInt32LE(data.length, 22);
          local.writeUInt16LE(nameBytes.length, 26);
          local.writeUInt16LE(0, 28);

          const header = Buffer.alloc(46);
          header.writeUInt32LE(CENTRAL_HEADER, 0);
          header.writeUInt16LE(VERSION, 4);
          header.writeUInt16LE(VERSION, 6);
          header.writeUInt16LE(UTF8_NAMES, 8);
          header.writeUInt16LE(0, 10);
          header.writeUInt16LE(DOS_TIME, 12);
          header.writeUInt16LE(DOS_DATE, 14);
          header.writeUInt32LE(checksum, 16);
          header.writeUInt32LE(data.length, 20);
          header.writeUInt32LE(data.length, 24);
          header.writeUInt16LE(nameBytes.length, 28);
          header.writeUInt32LE(offset, 42);
          central.push(header, nameBytes);

          controller.enqueue(new Uint8Array(Buffer.concat([local, nameBytes])));
          controller.enqueue(new Uint8Array(data));
          offset += 30 + nameBytes.length + data.length;
          return;
        }

        const directory = Buffer.concat(central);
        if (offset + directory.length > MAX_OFFSET) throw new Error("archive_too_large");
        const end = Buffer.alloc(22);
        end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
        end.writeUInt16LE(seen.size, 8);
        end.writeUInt16LE(seen.size, 10);
        end.writeUInt32LE(directory.length, 12);
        end.writeUInt32LE(offset, 16);
        controller.enqueue(new Uint8Array(Buffer.concat([directory, end])));
        finished = true;
        controller.close();
      } catch (error) {
        finished = true;
        await iterator.return?.();
        controller.error(error instanceof Error && error.message === "archive_too_large" ? error : new Error("archive_invalid"));
      }
    },
    async cancel() {
      finished = true;
      await iterator.return?.();
    }
  });
}

type CentralEntry = { name: string; crc: number; size: number; offset: number };

export type ZipStoreReader = {
  names(): string[];
  size(name: string): number;
  read(name: string, maxBytes: number): Promise<Buffer>;
  close(): Promise<void>;
};

async function readAt(handle: FileHandle, position: number, length: number) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) invalid();
  return buffer;
}

/**
 * Open an uncompressed ZIP archive for reading. Anything unusual - compression, encryption, ZIP64,
 * unsafe or repeated names, trailing or overlapping data - is refused as "archive_invalid".
 */
export async function openZipStore(filePath: string, options: { maxEntries?: number } = {}): Promise<ZipStoreReader> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size < 22 || size > MAX_OFFSET) invalid();

    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = await readAt(handle, size - tailLength, tailLength);
    let endAt = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY && index + 22 + tail.readUInt16LE(index + 20) === tail.length) {
        endAt = index;
        break;
      }
    }
    if (endAt < 0) invalid();
    const disk = tail.readUInt16LE(endAt + 4);
    const directoryDisk = tail.readUInt16LE(endAt + 6);
    const entriesHere = tail.readUInt16LE(endAt + 8);
    const entryCount = tail.readUInt16LE(endAt + 10);
    const directorySize = tail.readUInt32LE(endAt + 12);
    const directoryOffset = tail.readUInt32LE(endAt + 16);
    const endPosition = size - tailLength + endAt;
    if (disk !== 0 || directoryDisk !== 0 || entriesHere !== entryCount) invalid();
    if (entryCount === 0xffff || directorySize === MAX_OFFSET || directoryOffset === MAX_OFFSET) invalid();
    if (entryCount > (options.maxEntries ?? MAX_ENTRIES)) invalid();
    if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES || directoryOffset + directorySize !== endPosition) invalid();

    const directory = await readAt(handle, directoryOffset, directorySize);
    const entries = new Map<string, CentralEntry>();
    const seenFolders = new Set<string>();
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== CENTRAL_HEADER) invalid();
      const flags = directory.readUInt16LE(cursor + 8);
      const method = directory.readUInt16LE(cursor + 10);
      const crc = directory.readUInt32LE(cursor + 16);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const offset = directory.readUInt32LE(cursor + 42);
      const nameEnd = cursor + 46 + nameLength;
      if (nameEnd + extraLength + commentLength > directory.length) invalid();
      const name = directory.subarray(cursor + 46, nameEnd).toString("utf8");
      if ((flags & ENCRYPTED) !== 0 || method !== 0 || compressedSize !== uncompressedSize) invalid();
      if (compressedSize === MAX_OFFSET || offset === MAX_OFFSET) invalid();
      cursor = nameEnd + extraLength + commentLength;
      // Other tools list folders as empty entries ending in "/"; they hold nothing, so they are skipped.
      if (name.endsWith("/") && uncompressedSize === 0 && isSafeArchiveName(name.slice(0, -1))) {
        if (seenFolders.has(name)) invalid();
        seenFolders.add(name);
        continue;
      }
      if (!isSafeArchiveName(name) || entries.has(name)) invalid();
      if (offset + 30 + nameLength + uncompressedSize > directoryOffset) invalid();
      entries.set(name, { name, crc, size: uncompressedSize, offset });
    }
    if (cursor !== directory.length) invalid();

    return {
      names: () => [...entries.keys()],
      size: (name) => entries.get(name)?.size ?? invalid(),
      async read(name, maxBytes) {
        const entry = entries.get(name);
        if (!entry || entry.size > maxBytes) invalid();
        const local = await readAt(handle, entry.offset, 30);
        if (local.readUInt32LE(0) !== LOCAL_HEADER || local.readUInt16LE(8) !== 0) invalid();
        const localName = await readAt(handle, entry.offset + 30, local.readUInt16LE(26));
        if (localName.toString("utf8") !== entry.name) invalid();
        const dataStart = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        if (dataStart + entry.size > directoryOffset) invalid();
        const data = entry.size === 0 ? Buffer.alloc(0) : await readAt(handle, dataStart, entry.size);
        if (crc32(data) !== entry.crc) invalid();
        return data;
      },
      close: () => handle.close()
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof Error && error.message === "archive_invalid") throw error;
    throw new Error("archive_invalid");
  }
}
