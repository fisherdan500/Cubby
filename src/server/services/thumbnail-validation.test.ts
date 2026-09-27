import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: m.spawn }));
import { processFeedPhoto, validFeedPhotoThumbnail } from "./feed-photo-processing";
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const valid = "cubby-thumbnail-v1:valid\n";
function child() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
}
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });
it("validates only through a fixed one-image child without inherited credentials or preloads", async () => {
  const worker = child();
  m.spawn.mockReturnValue(worker);
  vi.stubEnv("NODE_OPTIONS", "--require arbitrary-preload");
  vi.stubEnv("DATABASE_URL", "synthetic-secret");
  vi.stubEnv("SMTP_PASSWORD", "synthetic-secret");
  const result = validFeedPhotoThumbnail(bytes);
  expect(m.spawn).toHaveBeenCalledWith(process.execPath, [path.join(process.cwd(), "runtime", "thumbnail-validator.cjs")], {
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}), NODE_ENV: "production", UV_THREADPOOL_SIZE: "1", VIPS_CONCURRENCY: "1" }
  });
  expect(worker.stdin.read()).toEqual(bytes);
  worker.stdout.emit("data", Buffer.from(valid));
  worker.emit("close", 0, null);
  await expect(result).resolves.toBe(true);
});
it("kills on the wall deadline but holds admission through exit until stdio close", async () => {
  vi.useFakeTimers();
  const worker = child();
  m.spawn.mockReturnValue(worker);
  let settled = false;
  const result = validFeedPhotoThumbnail(bytes).then((value) => { settled = true; return value; });
  try {
    await vi.advanceTimersByTimeAsync(5000);
    expect(worker.kill).toHaveBeenCalledWith("SIGKILL");
    expect(settled).toBe(false);
    await expect(processFeedPhoto(bytes)).rejects.toThrow("attachment_upload_busy");
    worker.stdout.emit("data", Buffer.from(valid));
    worker.emit("exit", 0, null);
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(validFeedPhotoThumbnail(bytes)).rejects.toThrow("attachment_upload_busy");
  } finally { worker.emit("close", 0, null); await result; }
  await expect(result).resolves.toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  m.spawn.mockImplementation(() => { throw new Error("raw-launch-detail"); });
  await expect(validFeedPhotoThumbnail(bytes)).resolves.toBe(false);
});
it.each(["stdout", "stderr"] as const)("bounds %s and ignores a later success until close", async (stream) => {
  const worker = child();
  m.spawn.mockReturnValue(worker);
  let settled = false;
  const result = validFeedPhotoThumbnail(bytes).then((value) => { settled = true; return value; });
  try {
    worker[stream].emit("data", Buffer.alloc(4097, 65));
    expect(worker.kill).toHaveBeenCalledWith("SIGKILL");
    worker.stdout.emit("data", Buffer.from(valid));
    await Promise.resolve();
    expect(settled).toBe(false);
    await expect(processFeedPhoto(bytes)).rejects.toThrow("attachment_upload_busy");
  } finally { worker.emit("close", 0, null); await result; }
  await expect(result).resolves.toBe(false);
});
it.each(["child", "stdin", "stdout", "stderr"] as const)("contains raw %s errors and awaits close", async (source) => {
  const worker = child();
  m.spawn.mockReturnValue(worker);
  const result = validFeedPhotoThumbnail(bytes);
  try {
    (source === "child" ? worker : worker[source]).emit("error", new Error("private-native-detail"));
    expect(worker.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(validFeedPhotoThumbnail(bytes)).rejects.toThrow("attachment_upload_busy");
    worker.stdout.emit("data", Buffer.from(valid));
  } finally { worker.emit("close", 0, null); await result; }
  await expect(result).resolves.toBe(false);
});
it.each([
  { output: "", code: 0, signal: null, stderr: "" },
  { output: "{\"valid\":true}", code: 0, signal: null, stderr: "" },
  { output: valid + valid, code: 0, signal: null, stderr: "" },
  { output: "cubby-thumbnail-v1:invalid\n", code: 0, signal: null, stderr: "" },
  { output: valid, code: 1, signal: null, stderr: "" },
  { output: valid, code: null, signal: "SIGKILL", stderr: "" },
  { output: valid, code: 0, signal: null, stderr: "private-warning" }
])("rejects malformed/negative protocol and abnormal completion %#", async ({ output, code, signal, stderr }) => {
  const worker = child();
  m.spawn.mockReturnValue(worker);
  const result = validFeedPhotoThumbnail(bytes);
  worker.stdout.emit("data", Buffer.from(output));
  if (stderr) worker.stderr.emit("data", Buffer.from(stderr));
  worker.emit("close", code, signal);
  await expect(result).resolves.toBe(false);
});
it("refuses oversized or unframed input without spawning", async () => {
  for (const input of [Buffer.alloc(0), Buffer.alloc(2 * 1024 * 1024 + 1), Buffer.from("not jpeg")]) {
    await expect(validFeedPhotoThumbnail(input)).resolves.toBe(false);
  }
  expect(m.spawn).not.toHaveBeenCalled();
});
it.each(["throws", "refuses"])("keeps capacity closed when termination %s", async (mode) => {
  vi.useFakeTimers();
  const worker = child();
  worker.kill.mockImplementation(() => { if (mode === "throws") throw new Error("private-kill-detail"); return false; });
  m.spawn.mockReturnValue(worker);
  let settled = false;
  const result = validFeedPhotoThumbnail(bytes).then((value) => { settled = true; return value; });
  try {
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(false);
    await expect(validFeedPhotoThumbnail(bytes)).rejects.toThrow("attachment_upload_busy");
  } finally { worker.emit("close", null, "SIGKILL"); await result; }
  await expect(result).resolves.toBe(false);
});
it("awaits close if sending input throws synchronously", async () => {
  const worker = child();
  vi.spyOn(worker.stdin, "end").mockImplementation(() => { throw new Error("private-write-detail"); });
  m.spawn.mockReturnValue(worker);
  const result = validFeedPhotoThumbnail(bytes);
  try {
    expect(worker.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(validFeedPhotoThumbnail(bytes)).rejects.toThrow("attachment_upload_busy");
  } finally { worker.emit("close", 0, null); await result.catch(() => undefined); }
  await expect(result).resolves.toBe(false);
});
it("actually kills and reaps a stalled synthetic Node child", async () => {
  const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const worker = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], {
    shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}), NODE_ENV: "production" }
  });
  const kill = vi.spyOn(worker, "kill");
  m.spawn.mockReturnValue(worker);
  try {
    await expect(validFeedPhotoThumbnail(bytes)).resolves.toBe(false);
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(worker.pid).toBeTypeOf("number");
    expect(() => process.kill(worker.pid!, 0)).toThrow();
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) {
      const closed = new Promise<void>((resolve) => worker.once("close", () => resolve()));
      worker.kill("SIGKILL");
      await closed;
    }
  }
}, 15_000);
