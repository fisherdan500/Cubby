import { createHash } from "node:crypto";
import sharp from "sharp";
import { attachmentPolicy } from "@/domain/attachments";

const policy = attachmentPolicy.feed_photo;
const accepted = new Set<string>(policy.acceptedFormats);

export type ProcessedFeedPhoto = {
  bytes: Buffer;
  byteSize: number;
  sha256: string;
  mimeType: typeof policy.outputMimeType;
  width: number;
  height: number;
};

// Big enough to look sharp as a single photo across a phone screen, small enough that a grid of them
// loads quickly on mobile data.
const THUMBNAIL_DIMENSION = 800;

/** A small copy of a stored photo, for grids; the full photo is kept for the viewer and for saving. */
export async function makeFeedPhotoThumbnail(photo: Buffer) {
  return sharp(photo, { limitInputPixels: policy.maxInputPixels, failOn: "truncated" })
    .resize({ width: THUMBNAIL_DIMENSION, height: THUMBNAIL_DIMENSION, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true })
    .toBuffer();
}

/**
 * Re-save an uploaded feed photo (DEC-PROD-422): the format is judged from the bytes, the photo is
 * turned the right way up, scaled to fit 2560px, and written as a fresh JPEG carrying no metadata -
 * no location, camera or orientation details. Anything unreadable, unsupported, truncated or too
 * large to decode safely is refused before any of it is kept.
 */
export async function processFeedPhoto(input: Buffer): Promise<ProcessedFeedPhoto> {
  if (input.length > policy.maxInputBytes) throw new Error("attachment_too_large");
  if (input.length === 0) throw new Error("attachment_unsupported_format");
  try {
    const decoder = () => sharp(input, { limitInputPixels: policy.maxInputPixels, failOn: "truncated", sequentialRead: true });
    const meta = await decoder().metadata();
    if (!meta.format || !accepted.has(meta.format) || (meta.pages ?? 1) > 1) throw new Error("attachment_unsupported_format");

    // Sharp writes no metadata unless asked to, so the output carries none of the original's.
    const { data, info } = await decoder()
      .rotate()
      .resize({ width: policy.maxDimension, height: policy.maxDimension, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: policy.outputQuality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: data,
      byteSize: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      mimeType: policy.outputMimeType,
      width: info.width,
      height: info.height
    };
  } catch {
    // Decoder messages can echo file details; only a fixed code leaves this function.
    throw new Error("attachment_unsupported_format");
  }
}
