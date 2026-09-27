import { afterEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ metadata: vi.fn(), toBuffer: vi.fn(), timeout: vi.fn() }));
vi.mock("sharp", () => ({ default: () => {
  const pipeline = { metadata: m.metadata, toBuffer: m.toBuffer, timeout: (options: unknown) => { m.timeout(options); return pipeline; }, rotate: () => pipeline, resize: () => pipeline, jpeg: () => pipeline };
  return pipeline;
} }));
import { processFeedPhoto, makeFeedPhotoThumbnail, validFeedPhotoThumbnail } from "./feed-photo-processing";
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
it("bounds native decode including thumbnails and keeps admission until late work settles", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  m.metadata.mockResolvedValue({ format: "jpeg" });
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => { started = r; });
  m.toBuffer.mockImplementationOnce(async () => { started(); await new Promise<void>((r) => { release = r; }); return { data: Buffer.from("jpeg"), info: { width: 1, height: 1 } }; });
  let outcome = "pending";
  const first = processFeedPhoto(Buffer.from("photo")).then(() => { outcome = "accepted"; }, (e: Error) => { outcome = e.message; });
  await ready;
  try {
    await expect(makeFeedPhotoThumbnail(Buffer.from("photo"))).rejects.toThrow("attachment_upload_busy");
    await expect(validFeedPhotoThumbnail(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).rejects.toThrow("attachment_upload_busy");
    await vi.advanceTimersByTimeAsync(30_001);
    expect(outcome).toBe("pending");
    await expect(processFeedPhoto(Buffer.from("photo"))).rejects.toThrow("attachment_upload_busy");
    expect(m.timeout).toHaveBeenCalledWith({ seconds: 30 });
  } finally { release(); await first; }
  expect(outcome).toBe("upload_timeout");
  m.toBuffer.mockResolvedValue({ data: Buffer.from("jpeg"), info: { width: 1, height: 1 } });
  await expect(processFeedPhoto(Buffer.from("photo"))).resolves.toMatchObject({ byteSize: 4 });
});
