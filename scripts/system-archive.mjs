// Closed, uncompressed USTAR/GNU-basic reader. No tar subprocess sees unvalidated names.
// Payloads are read in fixed chunks; metadata/member counts and physical extents are bounded.
import { constants, openSync, closeSync, fstatSync, readSync, writeSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const BLOCK = 512;
const CHUNK = 64 * 1024;
const MAX_ARCHIVE = 1024 ** 4; // 1 TiB overall, including framing and both payloads.
const MAX_MEMBERS = 1_000_000;
const MAX_PHOTO = 25 * 1024 * 1024;
const bad = (message = "not a Cubby system backup") => { throw new Error(message); };
const zero = (bytes) => bytes.every((value) => value === 0);
function read(fd, at, length) {
  const bytes = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const count = readSync(fd, bytes, done, length - done, at + done);
    if (!count) bad("truncated archive");
    done += count;
  }
  return bytes;
}
function chunks(fd, at, length, consume) {
  while (length > 0) {
    const count = Math.min(CHUNK, length);
    consume(read(fd, at, count));
    at += count;
    length -= count;
  }
}
function text(bytes) {
  const end = bytes.indexOf(0);
  const value = end < 0 ? bytes : bytes.subarray(0, end);
  if (end >= 0 && !zero(bytes.subarray(end))) bad("noncanonical tar field");
  if (!value.every((byte) => byte >= 32 && byte <= 126)) bad("non-ASCII tar field");
  return value.toString("ascii");
}
function octal(bytes) {
  const value = bytes.toString("latin1");
  if (!/^[0-7]+[\0 ]*$/.test(value)) bad("unsupported tar number");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) bad("excessive tar number");
  return number;
}
function tarSize(bytes) {
  if (bytes[0] !== 0x80) return octal(bytes);
  let size = 0n;
  for (const byte of bytes.subarray(1)) size = size * 256n + BigInt(byte);
  if (size > BigInt(MAX_ARCHIVE)) bad("excessive tar size");
  return Number(size);
}
function scan(fd, start, size, allow) {
  if (size < 1024 || size > MAX_ARCHIVE || size % BLOCK) bad("invalid tar extent");
  const end = start + size;
  let at = start;
  const entries = [];
  const seen = new Set();
  while (at < end) {
    const header = read(fd, at, BLOCK);
    if (zero(header)) {
      const remaining = end - at;
      if (remaining < 1024 || remaining > 10240) bad("invalid tar terminator");
      chunks(fd, at, remaining, (bytes) => { if (!zero(bytes)) bad("data after tar terminator"); });
      return entries;
    }
    if (entries.length >= MAX_MEMBERS) bad("too many tar members");
    const expected = octal(header.subarray(148, 156));
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (expected !== actual) bad("invalid tar header checksum");
    const magic = header.subarray(257, 265).toString("latin1");
    if (magic !== "ustar\0" + "00" && magic !== "ustar  \0") bad("unsupported tar header");
    // No prefixes, sparse descriptors, extensions, link targets or device numbers.
    if (!zero(header.subarray(345)) || text(header.subarray(157, 257)) !== "") bad("unsupported tar header");
    for (const [offset, length] of [[100, 8], [108, 8], [116, 8], [136, 12]]) octal(header.subarray(offset, offset + length));
    for (const offset of [329, 337]) {
      const field = header.subarray(offset, offset + 8);
      if (!zero(field) && octal(field) !== 0) bad("unsupported device header");
    }
    text(header.subarray(265, 297)); text(header.subarray(297, 329));
    if (octal(header.subarray(100, 108)) > 0o777) bad("special tar permission bits");
    const name = text(header.subarray(0, 100));
    const type = String.fromCharCode(header[156]);
    const length = tarSize(header.subarray(124, 136));
    if (!["0", "\0", "5"].includes(type) || (type === "5" && length !== 0)) bad("unsupported tar member type");
    const data = at + BLOCK;
    const extent = Math.ceil(length / BLOCK) * BLOCK;
    if (data + extent > end - 1024) bad("truncated tar member");
    const entry = { name, type, length, header: at, data, extent };
    const identity = allow(entry);
    if (seen.has(identity)) bad("duplicate tar member");
    seen.add(identity);
    // Padding is not another channel for records or data.
    if (!zero(read(fd, data + length, extent - length))) bad("nonzero tar padding");
    entries.push(entry);
    at = data + extent;
  }
  bad("missing tar terminator");
}
function outer(entry) {
  const limits = { "manifest.txt": 4096, "checksums.sha256": 256, "database.dump": MAX_ARCHIVE, "attachments.tar": MAX_ARCHIVE };
  if (!Object.hasOwn(limits, entry.name) || entry.type === "5" || entry.length === 0 || entry.length > limits[entry.name]) bad();
  return entry.name;
}
function inner(entry, version) {
  // tar -C root . produces precisely this spelling, including directory trailing slashes.
  if (entry.type === "5") {
    if (!/^\.\/(?:objects\/(?:[a-f0-9]{2}\/)?|)$/.test(entry.name) &&
        !(version === "1" && /^\.\/(?:thumbnails\/(?:[a-f0-9]{2}\/)?|restore-staging\/)$/.test(entry.name))) bad("invalid photo directory");
    entry.keep = entry.name === "./" || entry.name.startsWith("./objects/");
    return entry.name;
  }
  const object = /^\.\/(objects|thumbnails)\/([a-f0-9]{2})\/(?:([a-f0-9]{32})|\.([a-f0-9]{32})\.(write-v1|[a-f0-9]{16})\.tmp)$/.exec(entry.name);
  const upload = version === "1" && /^\.\/restore-staging\/[a-f0-9]{32}\.zip$/.test(entry.name);
  if (object) {
    const [, area, shard, key, temporaryKey, temporaryKind] = object;
    if (!(key ?? temporaryKey).startsWith(shard) || (area === "thumbnails" && version !== "1")) bad("invalid photo path");
    if (entry.length > MAX_PHOTO) bad("excessive photo member");
    entry.keep = area === "objects" && (Boolean(key) || temporaryKind === "write-v1");
  } else if (upload) {
    if (entry.length > 2 * 1024 ** 3) bad("excessive legacy upload");
    entry.keep = false;
  } else bad("invalid photo path");
  return entry.name;
}
function metadata(fd, entry) { return read(fd, entry.data, entry.length).toString("latin1"); }
function validate(fd, migrations) {
  const stats = fstatSync(fd);
  if (!stats.isFile()) bad("archive must be a regular file");
  const entries = scan(fd, 0, stats.size, outer);
  if (entries.length !== 4) bad();
  const byName = Object.fromEntries(entries.map((entry) => [entry.name, entry]));
  const manifestBytes = read(fd, byName["manifest.txt"].data, byName["manifest.txt"].length);
  if (!manifestBytes.every((byte) => byte === 10 || (byte >= 32 && byte <= 126))) bad("invalid manifest bytes");
  const manifest = manifestBytes.toString("ascii");
  const match = /^format=cubby-system-backup-([12])\ncreated=(\d{8}T\d{6}Z)\nrevision=(unknown|[a-f0-9]{7,40})\nmigration=(\d{14}_[a-zA-Z0-9_]+)\nhouseholds=(0|[1-9]\d{0,14})\naccounts=(0|[1-9]\d{0,14})\nphotos=(0|[1-9]\d{0,14})\n$/.exec(manifest);
  if (!match) bad("invalid system manifest");
  const [, version, created, , migration] = match;
  const iso = created.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z");
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso.replace("Z", ".000Z")) bad("invalid manifest date");
  if (migrations) {
    let directory;
    try { directory = lstatSync(path.join(migrations, migration)); } catch { bad("archive comes from a newer Cubby; update this checkout first"); }
    if (!directory.isDirectory() || directory.isSymbolicLink()) bad("invalid migration directory");
  }
  const sums = metadata(fd, byName["checksums.sha256"]);
  if (!/^[a-f0-9]{64} [ *]database\.dump\n[a-f0-9]{64} [ *]attachments\.tar\n$/.test(sums)) bad("invalid checksum coverage");
  for (const line of sums.trimEnd().split("\n")) {
    const expected = line.slice(0, 64);
    const name = line.slice(66);
    const entry = byName[name];
    const hash = createHash("sha256");
    chunks(fd, entry.data, entry.length, (bytes) => hash.update(bytes));
    if (hash.digest("hex") !== expected) bad("a checksum does not match");
  }
  const photos = byName["attachments.tar"];
  const originals = scan(fd, photos.data, photos.length, (entry) => inner(entry, version));
  return { byName, originals };
}
function output(file, write) {
  const fd = openSync(file, "wx", 0o600);
  try {
    write((bytes) => {
      let done = 0;
      while (done < bytes.length) done += writeSync(fd, bytes, done, bytes.length - done);
    });
  } finally { closeSync(fd); }
}
function main() {
  const [mode, file, migrations, destination] = process.argv.slice(2);
  if (!["check", "prepare", "size"].includes(mode) || !file || !migrations || (mode === "prepare" && !destination)) bad("invalid validator arguments");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size < 1024 || stats.size > MAX_ARCHIVE) bad("invalid archive size");
    if (mode === "size") return;
    const { byName, originals } = validate(fd, migrations);
    // Validation of BOTH levels and all payload checksums completes before any extraction.
    if (mode === "prepare") {
      for (const name of ["manifest.txt", "database.dump"]) {
        const entry = byName[name];
        output(path.join(destination, name), (write) => chunks(fd, entry.data, entry.length, write));
      }
      output(path.join(destination, "attachments.tar"), (write) => {
        for (const entry of originals.filter((entry) => entry.keep)) chunks(fd, entry.header, BLOCK + entry.extent, write);
        write(Buffer.alloc(1024));
      });
    }
  } finally { closeSync(fd); }
}
try { main(); } catch (error) {
  console.error(`system_archive_invalid: ${error instanceof Error && error.code === undefined ? error.message : "archive I/O failed"}`);
  process.exitCode = 1;
}
