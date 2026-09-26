import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { makeFeedPhotoThumbnail, processFeedPhoto } from "@/server/services/feed-photo-processing";

const exif = { IFD0: { Make: "ProbeCam", Model: "Private Model" }, GPSIFD: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } };

function image(width: number, height: number, format: "jpeg" | "png" | "webp" | "gif" | "tiff" = "jpeg") {
  return sharp({ create: { width, height, channels: 3, background: "#88aacc" } }).withExifMerge(exif).toFormat(format).toBuffer();
}

describe("makeFeedPhotoThumbnail", () => {
  it("makes a small JPEG no larger than 800px for grids, keeping the photo's shape", async () => {
    const photo = await processFeedPhoto(await image(2560, 1920));
    const thumbnail = await makeFeedPhotoThumbnail(photo.bytes);
    const meta = await sharp(thumbnail).metadata();

    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 800, 600]);
    expect(thumbnail.length).toBeLessThan(photo.bytes.length);
    expect(meta.exif).toBeUndefined();
  });

  it("never enlarges a photo already smaller than a thumbnail", async () => {
    const photo = await processFeedPhoto(await image(300, 400));
    const meta = await sharp(await makeFeedPhotoThumbnail(photo.bytes)).metadata();
    expect([meta.width, meta.height]).toEqual([300, 400]);
  });
});

describe("processFeedPhoto", () => {
  it("re-saves a photo as JPEG no larger than 2560px, keeping its shape", async () => {
    const photo = await processFeedPhoto(await image(4000, 3000));

    expect(photo).toMatchObject({ mimeType: "image/jpeg", width: 2560, height: 1920 });
    const meta = await sharp(photo.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 2560, 1920]);
    expect(photo.byteSize).toBe(photo.bytes.length);
    expect(photo.sha256).toBe(createHash("sha256").update(photo.bytes).digest("hex"));
  });

  it("removes location and camera details", async () => {
    const photo = await processFeedPhoto(await image(800, 600));
    const meta = await sharp(photo.bytes).metadata();

    expect(meta.exif).toBeUndefined();
    expect(photo.bytes.includes(Buffer.from("ProbeCam"))).toBe(false);
    expect(photo.bytes.includes(Buffer.from("Private Model"))).toBe(false);
  });

  it("never enlarges a small photo", async () => {
    expect(await processFeedPhoto(await image(640, 480, "png"))).toMatchObject({ width: 640, height: 480 });
  });

  it("turns a photo the right way up before its orientation note is dropped", async () => {
    // Stored sideways with an orientation flag saying so, as phones do.
    const sideways = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#ffffff" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    expect(await processFeedPhoto(sideways)).toMatchObject({ width: 200, height: 300 });
  });

  it("accepts JPEG, PNG and WebP, judged by the bytes themselves", async () => {
    for (const format of ["jpeg", "png", "webp"] as const) {
      await expect(processFeedPhoto(await image(100, 100, format))).resolves.toMatchObject({ mimeType: "image/jpeg" });
    }
  });

  it("refuses anything else, including files that only claim to be images", async () => {
    await expect(processFeedPhoto(await image(100, 100, "gif"))).rejects.toThrow("attachment_unsupported_format");
    await expect(processFeedPhoto(await image(100, 100, "tiff"))).rejects.toThrow("attachment_unsupported_format");
    await expect(processFeedPhoto(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).rejects.toThrow("attachment_unsupported_format");
    await expect(processFeedPhoto(Buffer.from("not an image at all"))).rejects.toThrow("attachment_unsupported_format");
    await expect(processFeedPhoto(Buffer.alloc(0))).rejects.toThrow("attachment_unsupported_format");
  });

  it("refuses a file over the upload limit before decoding it", async () => {
    await expect(processFeedPhoto(Buffer.alloc(25 * 1024 * 1024 + 1))).rejects.toThrow("attachment_too_large");
  });

  it("refuses an image whose pixel count would exhaust memory", async () => {
    // 12000 x 9000 = 108 million pixels: small as a file, huge once decoded.
    const huge = await sharp({ create: { width: 12000, height: 9000, channels: 3, background: "#000000" } }).png({ compressionLevel: 9 }).toBuffer();
    await expect(processFeedPhoto(huge)).rejects.toThrow("attachment_unsupported_format");
  });

  it("refuses a truncated image rather than saving half of it", async () => {
    const whole = await image(800, 600);
    await expect(processFeedPhoto(whole.subarray(0, Math.floor(whole.length / 2)))).rejects.toThrow("attachment_unsupported_format");
  });
});
