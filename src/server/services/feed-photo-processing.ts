import { createHash } from "node:crypto";
import sharp from "sharp";
import { attachmentPolicy, type AttachmentTypeName } from "@/domain/attachments";
import { validateThumbnailInChild } from "./thumbnail-validation";

const policy = attachmentPolicy.feed_photo;
const accepted = new Set<string>(policy.acceptedFormats);

/** Each type re-saves through the same path under its own limits; the set is built once per type. */
const acceptedByType: Record<AttachmentTypeName, ReadonlySet<string>> = {
  feed_photo: new Set<string>(attachmentPolicy.feed_photo.acceptedFormats),
  baby_photo: new Set<string>(attachmentPolicy.baby_photo.acceptedFormats),
  user_photo: new Set<string>(attachmentPolicy.user_photo.acceptedFormats)
};
const admission = globalThis as typeof globalThis & { cubbyPhotoDecodeActive?: boolean };

async function withPhotoDecode<T>(work: (check: () => void) => Promise<T>): Promise<T> {
  if (admission.cubbyPhotoDecodeActive) throw new Error("attachment_upload_busy");
  admission.cubbyPhotoDecodeActive = true;
  const deadline = performance.now() + 30_000;
  const check = () => { if (performance.now() >= deadline) throw new Error("upload_timeout"); };
  try {
    const result = await work(check);
    check();
    return result;
  } catch (error) {
    check();
    throw error;
  } finally {
    // Sharp's timeout excludes native queue time. Never release over still-running work.
    admission.cubbyPhotoDecodeActive = false;
  }
}

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

/** Validate pixels, not just the header, within the shared native-work budget. */
export async function validFeedPhotoThumbnail(bytes: Buffer): Promise<boolean> {
  // libjpeg tolerates a missing end marker even in strict mode; our own encoder always writes it.
  if (bytes.length < 4 || bytes.length > 2 * 1024 * 1024 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return false;
  // An OS child owns the native warning queue; in-process listeners cannot attribute it.
  return withPhotoDecode(() => validateThumbnailInChild(bytes));
}

/** A small copy of a stored photo, for grids; the full photo is kept for the viewer and for saving. */
export async function makeFeedPhotoThumbnail(photo: Buffer) {
  return withPhotoDecode(async () => sharp(photo, { limitInputPixels: policy.maxInputPixels, failOn: "truncated" })
    .timeout({ seconds: 30 })
    .resize({ width: THUMBNAIL_DIMENSION, height: THUMBNAIL_DIMENSION, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true })
    .toBuffer());
}

/**
 * Re-save an uploaded feed photo (DEC-PROD-422): the format is judged from the bytes, the photo is
 * turned the right way up, scaled to fit 2560px, and written as a fresh JPEG carrying no metadata -
 * no location, camera or orientation details. Anything unreadable, unsupported, truncated or too
 * large to decode safely is refused before any of it is kept.
 */
export async function processFeedPhoto(input: Buffer): Promise<ProcessedFeedPhoto> {
  return processAttachmentPhoto(input, "feed_photo");
}

/**
 * Re-save an upload under the policy of its own type. A baby photo is stored smaller than a feed
 * photo, but goes through exactly the same re-encode - which is what strips location and camera
 * data, so the stored bytes are never the uploaded original.
 */
export async function processAttachmentPhoto(input: Buffer, type: AttachmentTypeName): Promise<ProcessedFeedPhoto> {
  return withPhotoDecode((check) => decodeAttachmentPhoto(input, type, check));
}

async function decodeAttachmentPhoto(input: Buffer, type: AttachmentTypeName, check: () => void): Promise<ProcessedFeedPhoto> {
  const typePolicy = attachmentPolicy[type];
  const typeAccepted = acceptedByType[type];
  if (input.length > typePolicy.maxInputBytes) throw new Error("attachment_too_large");
  if (input.length === 0) throw new Error("attachment_unsupported_format");
  try {
    const decoder = () => sharp(input, { limitInputPixels: typePolicy.maxInputPixels, failOn: "truncated", sequentialRead: true }).timeout({ seconds: 30 });
    const meta = await decoder().metadata();
    check();
    if (!meta.format || !typeAccepted.has(meta.format) || (meta.pages ?? 1) > 1) throw new Error("attachment_unsupported_format");

    // Sharp writes no metadata unless asked to, so the output carries none of the original's.
    const { data, info } = await decoder()
      .rotate()
      .resize({ width: typePolicy.maxDimension, height: typePolicy.maxDimension, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: typePolicy.outputQuality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: data,
      byteSize: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      mimeType: typePolicy.outputMimeType,
      width: info.width,
      height: info.height
    };
  } catch {
    // Decoder messages can echo file details; only a fixed code leaves this function.
    throw new Error("attachment_unsupported_format");
  }
}
