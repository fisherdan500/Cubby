import { mkdtemp, readdir, readFile, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ directory: "" }));
vi.mock("@/lib/env", () => ({ attachmentConfig: { get directory() { return state.directory; } } }));

import { sweepStaleBackupUploads, withUploadedBackupArchive } from "@/server/services/backup-upload";

beforeEach(async () => {
  state.directory = await mkdtemp(path.join(os.tmpdir(), "cubby-upload-"));
});
afterEach(async () => {
  await rm(state.directory, { recursive: true, force: true });
});

const upload = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("https://cubby.test/api/backups/restore", { method: "POST", body, headers: { "content-type": "application/zip", ...headers } });

describe("uploaded backup archives", () => {
  it("hands the work a private copy of the upload, and removes it afterwards", async () => {
    let seen = "";
    const result = await withUploadedBackupArchive(upload(new Uint8Array([1, 2, 3])), async (filePath) => {
      seen = filePath;
      expect(await readFile(filePath)).toEqual(Buffer.from([1, 2, 3]));
      return "done";
    });

    expect(result).toBe("done");
    expect(path.dirname(seen)).toBe(path.join(state.directory, "restore-staging"));
    expect(await readdir(path.join(state.directory, "restore-staging"))).toEqual([]);
  });

  it("removes the copy even when the work fails", async () => {
    await expect(withUploadedBackupArchive(upload(new Uint8Array([1])), async () => { throw new Error("backup_invalid"); })).rejects.toThrow("backup_invalid");
    expect(await readdir(path.join(state.directory, "restore-staging"))).toEqual([]);
  });

  it("refuses an upload over the limit, declared or actual, keeping nothing of it", async () => {
    const work = vi.fn();
    await expect(withUploadedBackupArchive(upload(new Uint8Array([1]), { "content-length": String(3 * 1024 * 1024 * 1024) }), work)).rejects.toThrow("archive_too_large");
    await expect(withUploadedBackupArchive(upload(new Uint8Array(10)), work, { maxBytes: 5 })).rejects.toThrow("archive_too_large");
    expect(work).not.toHaveBeenCalled();
    expect(await readdir(path.join(state.directory, "restore-staging"))).toEqual([]);
  });

  it("clears uploads left behind by an interrupted restore after a day", async () => {
    const staging = path.join(state.directory, "restore-staging");
    const old = `${"a".repeat(32)}.zip`;
    const recent = `${"b".repeat(32)}.zip`;
    await mkdir(staging, { recursive: true });
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const name of [old, recent, "someone-elses.txt"]) await writeFile(path.join(staging, name), "x");
    await utimes(path.join(staging, old), dayAgo, dayAgo);
    await utimes(path.join(staging, "someone-elses.txt"), dayAgo, dayAgo);

    await expect(sweepStaleBackupUploads()).resolves.toBe(1);
    expect((await readdir(staging)).sort()).toEqual([recent, "someone-elses.txt"]);
  });
});
