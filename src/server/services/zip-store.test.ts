import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { openZipStore, zipStoreStream } from "@/server/services/zip-store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempFile(bytes: Uint8Array) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cubby-zip-"));
  roots.push(root);
  const file = path.join(root, "archive.zip");
  await writeFile(file, bytes);
  return file;
}

async function collect(stream: ReadableStream<Uint8Array>) {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

async function* entries(list: Array<{ name: string; data: Buffer }>) {
  for (const entry of list) yield entry;
}

const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

describe("zip store archives", () => {
  it("writes an archive its own reader and other tools can open", async () => {
    const bytes = await collect(zipStoreStream(entries([
      { name: "backup.json", data: Buffer.from('{"ok":true}') },
      { name: "photos/p1.jpg", data: photo }
    ])));

    const zip = await openZipStore(await tempFile(bytes));
    expect(zip.names()).toEqual(["backup.json", "photos/p1.jpg"]);
    expect((await zip.read("backup.json", 100)).toString()).toBe('{"ok":true}');
    expect(await zip.read("photos/p1.jpg", 100)).toEqual(photo);

    // An ordinary zip library reads it too.
    const other = await JSZip.loadAsync(bytes);
    expect(await other.file("photos/p1.jpg")!.async("nodebuffer")).toEqual(photo);
  });

  it("reads an uncompressed archive made by another tool", async () => {
    const other = new JSZip();
    other.file("backup.json", '{"a":1}');
    other.file("photos/p2.jpg", photo);
    const bytes = await other.generateAsync({ type: "uint8array", compression: "STORE" });

    const zip = await openZipStore(await tempFile(bytes));
    expect(zip.names().sort()).toEqual(["backup.json", "photos/p2.jpg"]);
    expect(await zip.read("photos/p2.jpg", 100)).toEqual(photo);
  });

  it("refuses compressed entries, rather than trusting a decompressor with an upload", async () => {
    const other = new JSZip();
    other.file("backup.json", "x".repeat(1000));
    const bytes = await other.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    await expect(openZipStore(await tempFile(bytes))).rejects.toThrow("archive_invalid");
  });

  it("writes only plain relative names, each once", async () => {
    for (const name of ["../evil.json", "/abs.json", "photos\\p.jpg", "photos//p.jpg", "photos/./p.jpg", ""]) {
      await expect(collect(zipStoreStream(entries([{ name, data: photo }])))).rejects.toThrow("archive_invalid");
    }
    await expect(collect(zipStoreStream(entries([{ name: "a.json", data: photo }, { name: "a.json", data: photo }])))).rejects.toThrow("archive_invalid");
  });

  it("refuses to open an archive whose names could escape, or that names one entry twice", async () => {
    // Same-length stand-ins are written, then swapped for the unsafe names in the raw bytes.
    for (const [safe, unsafe] of [["xx/evil.json", "../evil.json"], ["photos_p.jpg", "photos\\p.jpg"]]) {
      const bytes = await collect(zipStoreStream(entries([{ name: safe, data: photo }])));
      const patched = Buffer.from(bytes.toString("latin1").split(safe).join(unsafe), "latin1");
      await expect(openZipStore(await tempFile(patched))).rejects.toThrow("archive_invalid");
    }
    const two = await collect(zipStoreStream(entries([{ name: "a.json", data: photo }, { name: "b.json", data: photo }])));
    const doubled = Buffer.from(two.toString("latin1").split("b.json").join("a.json"), "latin1");
    await expect(openZipStore(await tempFile(doubled))).rejects.toThrow("archive_invalid");
  });

  it("notices a damaged entry and a truncated archive", async () => {
    const bytes = await collect(zipStoreStream(entries([{ name: "photos/p1.jpg", data: photo }])));
    const damaged = Buffer.from(bytes);
    damaged[damaged.indexOf(photo) + 5] ^= 0xff;
    const zip = await openZipStore(await tempFile(damaged));
    await expect(zip.read("photos/p1.jpg", 100)).rejects.toThrow("archive_invalid");

    await expect(openZipStore(await tempFile(bytes.subarray(0, bytes.length - 10)))).rejects.toThrow("archive_invalid");
    await expect(openZipStore(await tempFile(Buffer.from("not a zip")))).rejects.toThrow("archive_invalid");
  });

  it("will not read an entry larger than the caller allows", async () => {
    const bytes = await collect(zipStoreStream(entries([{ name: "backup.json", data: Buffer.alloc(200) }])));
    const zip = await openZipStore(await tempFile(bytes));
    await expect(zip.read("backup.json", 100)).rejects.toThrow("archive_invalid");
    await expect(zip.read("missing.json", 100)).rejects.toThrow("archive_invalid");
  });

  it("keeps the archive file untouched while reading it", async () => {
    const bytes = await collect(zipStoreStream(entries([{ name: "backup.json", data: Buffer.from("{}") }])));
    const file = await tempFile(bytes);
    const zip = await openZipStore(file);
    await zip.read("backup.json", 10);
    await zip.close();
    expect(await readFile(file)).toEqual(bytes);
  });
});
