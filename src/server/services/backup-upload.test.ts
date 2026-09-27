import { mkdtemp, readdir, readFile, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ directory: "", failUnlink: false }));
vi.mock("@/lib/env", () => ({ attachmentConfig: { get directory() { return state.directory; } } }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, unlink: async (...args: Parameters<typeof fs.unlink>) => {
    if (state.failUnlink) throw new Error("synthetic_unlink_failure");
    return fs.unlink(...args);
  } };
});

import { sweepStaleBackupUploads, withUploadedBackupArchive } from "@/server/services/backup-upload";

beforeEach(async () => {
  state.directory = await mkdtemp(path.join(os.tmpdir(), "cubby-upload-"));
});
afterEach(async () => {
  await rm(state.directory, { recursive: true, force: true });
});

const upload = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("https://cubby.test/api/backups/restore", { method: "POST", body, headers: { "content-type": "application/zip", ...headers } });


function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

it("reserves the entire archive allowance before staging and holds admission through work and cleanup", async () => {
  const entered = barrier();
  const finish = barrier();
  const first = withUploadedBackupArchive(upload(new Uint8Array([1])), async () => {
    entered.release();
    await finish.promise;
  });
  await entered.promise;
  try {
    for (const headers of [{}, { "content-length": "1" }] as Record<string, string>[]) {
      const next = upload(new Uint8Array([2]), headers);
      const reader = vi.spyOn(next.body!, "getReader");
      const result = await withUploadedBackupArchive(next, async () => "unexpected").then(() => "accepted", (error: Error) => error.message);
      expect({ result, readers: reader.mock.calls.length, files: (await readdir(path.join(state.directory, "restore-staging"))).length })
        .toEqual({ result: "backup_upload_busy", readers: 0, files: 1 });
    }
  } finally {
    finish.release();
    await first;
  }
  await expect(withUploadedBackupArchive(upload(new Uint8Array([3])), async () => "released")).resolves.toBe("released");
  expect(await readdir(path.join(state.directory, "restore-staging"))).toEqual([]);
});

it.each(["deadline", "disconnect"] as const)("cancels a stalled reader on %s, cleans its file and releases admission", async (reason) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const abort = new AbortController();
  const cancelled = vi.fn();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel: cancelled });
  const request = new Request("https://cubby.test/upload", { method: "POST", body, signal: abort.signal, duplex: "half" } as RequestInit);
  const entered = barrier();
  const original = request.body!.getReader.bind(request.body);
  vi.spyOn(request.body!, "getReader").mockImplementation(() => { entered.release(); return original(); });
  const work = vi.fn();
  let outcome = "pending";
  const pending = withUploadedBackupArchive(request, work).then(() => { outcome = "accepted"; }, (error: Error) => { outcome = error.message; });
  try {
    await entered.promise;
    if (reason === "deadline") await vi.advanceTimersByTimeAsync(120_001);
    else abort.abort();
    // Cancellation closes the outstanding read; filesystem cleanup is awaited below.
    await Promise.resolve();
    expect(cancelled).toHaveBeenCalledOnce();
    await pending;
    expect(outcome).toBe(reason === "deadline" ? "backup_upload_timeout" : "backup_upload_aborted");
    expect(work).not.toHaveBeenCalled();
    expect(request.body!.locked).toBe(false);
    expect(await readdir(path.join(state.directory, "restore-staging"))).toEqual([]);
    await expect(withUploadedBackupArchive(upload(new Uint8Array([1])), async () => "released")).resolves.toBe("released");
  } finally {
    if (!cancelled.mock.calls.length) controller.close();
    await pending;
    vi.useRealTimers();
  }
});

it("keeps admission closed when staging cleanup fails instead of accumulating more files", async () => {
  try {
    state.failUnlink = true;
    const first = await withUploadedBackupArchive(upload(new Uint8Array([1])), async () => "done").then(() => "accepted", (error: Error) => error.message);
    expect(first).toBe("attachment_store_unavailable");
    state.failUnlink = false;
    const next = upload(new Uint8Array([2]));
    const reader = vi.spyOn(next.body!, "getReader");
    await expect(withUploadedBackupArchive(next, async () => "unexpected")).rejects.toThrow("backup_upload_busy");
    expect(reader).not.toHaveBeenCalled();
    expect(await readdir(path.join(state.directory, "restore-staging"))).toHaveLength(1);
  } finally {
    state.failUnlink = false;
    // Only reset this synthetic process latch after observing the refusal; production requires restart.
    const stateForTest = globalThis as typeof globalThis & { cubbyBackupUploadActive?: boolean; cubbyBackupUploadCleanupFailed?: boolean };
    stateForTest.cubbyBackupUploadActive = false;
    stateForTest.cubbyBackupUploadCleanupFailed = false;
  }
});

it("does not release admission while stream cancellation is still settling", async () => {
  const entered = barrier();
  const cancelFinish = barrier();
  const abort = new AbortController();
  const cancel = vi.fn(() => { entered.release(); return cancelFinish.promise; });
  const body = new ReadableStream<Uint8Array>({ cancel });
  const request = new Request("https://cubby.test/upload", { method: "POST", body, signal: abort.signal, duplex: "half" } as RequestInit);
  const pending = withUploadedBackupArchive(request, vi.fn()).catch((error: Error) => error.message);
  // The abort is deferred until a reader is acquired, without relying on filesystem timing.
  const original = request.body!.getReader.bind(request.body);
  // withUploadedBackupArchive starts synchronously, so its reader may already be locked.
  if (request.body!.locked) abort.abort();
  else vi.spyOn(request.body!, "getReader").mockImplementation(() => { const reader = original(); queueMicrotask(() => abort.abort()); return reader; });
  try {
    await entered.promise;
    await expect(withUploadedBackupArchive(upload(new Uint8Array([1])), vi.fn())).rejects.toThrow("backup_upload_busy");
  } finally {
    cancelFinish.release();
    expect(await pending).toBe("backup_upload_aborted");
  }
  expect(request.body!.locked).toBe(false);
  expect(await readdir(path.join(state.directory, "restore-staging"))).toEqual([]);
  await expect(withUploadedBackupArchive(upload(new Uint8Array([2])), async () => "released")).resolves.toBe("released");
});

it("rejects actual bytes despite a misleading short Content-Length and releases admission", async () => {
  const work = vi.fn();
  await expect(withUploadedBackupArchive(upload(new Uint8Array(8), { "content-length": "1" }), work, { maxBytes: 4 })).rejects.toThrow("archive_too_large");
  expect(work).not.toHaveBeenCalled();
  expect(await readdir(path.join(state.directory, "restore-staging"))).toEqual([]);
  await expect(withUploadedBackupArchive(upload(new Uint8Array([1])), async () => "released")).resolves.toBe("released");
});

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
