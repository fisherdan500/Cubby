import { randomBytes } from "node:crypto";

/**
 * Attachment types and their policy (DEC-PROD-141, DEC-PROD-422). Each type is enabled on its own,
 * and only once its whole gate - storage, private delivery, recovery and backup - has passed. Feed
 * photos are the first type: re-saved by the server without location or camera data, so the stored
 * bytes are never the uploaded original. Baby photos are the second, and are declared here ahead of
 * being switched on so the database and policy can land before staging, delivery and backup do.
 */

export const attachmentTypes = ["feed_photo", "baby_photo"] as const;
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
  },
  baby_photo: {
    // A baby has exactly one current picture. The partial unique index
    // "Attachment_one_available_baby_photo" enforces the same thing in the database, because a
    // policy number alone cannot stop two concurrent writes.
    maxPerParent: 1,
    maxInputBytes: 25 * 1024 * 1024,
    maxInputPixels: 100_000_000,
    // A profile picture is shown small, so it is stored small.
    maxDimension: 512,
    acceptedFormats: ["jpeg", "png", "webp"],
    outputMimeType: "image/jpeg",
    outputQuality: 82
  }
} as const satisfies Record<AttachmentTypeName, unknown>;

// Switched on per type once its gate passes (DEC-PROD-070). Feed photos passed with storage, private
// delivery, 30-day recovery, and manual and automated backup and restore that carry them (#148-#151).
// Setting a type back to false switches it off again: uploads refuse and nothing is served.
//
// Both types are on. baby_photo was held false until all four of its policy gates passed - storage,
// private delivery, recovery, and backup - because enabling it earlier would have let a household
// store a picture that no backup contained and no restore returned.
const enabledTypes: Record<AttachmentTypeName, boolean> = { feed_photo: true, baby_photo: true };

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
