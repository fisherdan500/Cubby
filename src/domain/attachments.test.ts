import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_RECOVERY_DAYS,
  attachmentPolicy,
  attachmentPurgeAfter,
  attachmentTypeEnabled,
  isAttachmentStorageKey,
  newAttachmentStorageKey
} from "@/domain/attachments";

describe("attachment type policy", () => {
  it("defines feed photos narrowly: up to 10 per post, re-saved as JPEG no larger than 2560px", () => {
    expect(attachmentPolicy.feed_photo).toMatchObject({
      maxPerParent: 10,
      maxInputBytes: 25 * 1024 * 1024,
      maxDimension: 2560,
      acceptedFormats: ["jpeg", "png", "webp"],
      outputMimeType: "image/jpeg"
    });
  });

  it("switches feed photos on now that their whole gate has passed, and can switch them off again", () => {
    // DEC-PROD-070 / DEC-PROD-422: storage, private delivery, recovery and backup with photos are all in.
    expect(attachmentTypeEnabled("feed_photo")).toBe(true);
    expect(attachmentTypeEnabled("feed_photo", { feed_photo: false })).toBe(false);
  });

  it("keeps a removed attachment recoverable for thirty days", () => {
    expect(ATTACHMENT_RECOVERY_DAYS).toBe(30);
    expect(attachmentPurgeAfter(new Date("2026-09-27T12:00:00Z")).toISOString()).toBe("2026-10-27T12:00:00.000Z");
  });

  it("stores bytes under random, meaningless names only", () => {
    const key = newAttachmentStorageKey();
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(newAttachmentStorageKey()).not.toBe(key);
    expect(isAttachmentStorageKey(key)).toBe(true);
    for (const unsafe of ["../etc/passwd", "photo.jpg", "A".repeat(32), `${key}/x`, ""]) {
      expect(isAttachmentStorageKey(unsafe)).toBe(false);
    }
  });
});
