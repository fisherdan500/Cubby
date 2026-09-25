import { randomBytes } from "node:crypto";

/**
 * Attachment types and their policy (DEC-PROD-141, DEC-PROD-422). Each type is enabled on its own,
 * and only once its whole gate - storage, private delivery, recovery and backup - has passed. Feed
 * photos are the first type: re-saved by the server without location or camera data, so the stored
 * bytes are never the uploaded original.
 */

export const attachmentTypes = ["feed_photo"] as const;
export type AttachmentTypeName = (typeof attachmentTypes)[number];

export const attachmentPolicy = {
  feed_photo: {
    maxPerParent: 10,
    maxInputBytes: 25 * 1024 * 1024,
    // Guards decoding against images that are small on disk but enormous in memory.
    maxInputPixels: 100_000_000,
    maxDimension: 2560,
    // Detected from the bytes themselves; a filename or declared type is never trusted.
    acceptedFormats: ["jpeg", "png", "webp"],
    outputMimeType: "image/jpeg",
    outputQuality: 82
  }
} as const satisfies Record<AttachmentTypeName, unknown>;

// Switched on per type once its gate passes (DEC-PROD-070). Feed photos wait for backup and restore.
const enabledTypes: Record<AttachmentTypeName, boolean> = { feed_photo: false };

export function attachmentTypeEnabled(type: AttachmentTypeName, overrides?: Partial<Record<AttachmentTypeName, boolean>>) {
  return overrides?.[type] ?? enabledTypes[type];
}

/** How long a removed attachment stays privately recoverable before it is purged (DEC-PROD-146). */
export const ATTACHMENT_RECOVERY_DAYS = 30;

export function attachmentPurgeAfter(deletedAt: Date) {
  return new Date(deletedAt.getTime() + ATTACHMENT_RECOVERY_DAYS * 24 * 60 * 60 * 1000);
}

/** A staged upload that nothing claimed within this long is cleared away. */
export const STAGED_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

const STORAGE_KEY = /^[a-f0-9]{32}$/;

/** A random, meaningless storage name: never derived from the file, its name or its owner. */
export function newAttachmentStorageKey() {
  return randomBytes(16).toString("hex");
}

export function isAttachmentStorageKey(value: string) {
  return STORAGE_KEY.test(value);
}
