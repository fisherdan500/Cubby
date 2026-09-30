import { describe, expect, it } from "vitest";

import {
  attachmentPolicy,
  attachmentTypeEnabled,
  attachmentTypes,
  type AttachmentTypeName
} from "@/domain/attachments";

describe("baby photo attachment policy", () => {
  it("declares baby_photo as a known type", () => {
    expect(attachmentTypes).toContain("baby_photo");
  });

  it("is switched on now that its whole gate has passed", () => {
    // DEC-PROD-070: a type is enabled only once storage, private delivery, recovery and backup have
    // all passed. All four are built and proven for baby photos, so the type ships on. If any of
    // those paths is ever regressed, this flag is what must go back to false.
    expect(attachmentTypeEnabled("baby_photo")).toBe(true);
    expect(attachmentTypeEnabled("feed_photo")).toBe(true);
  });

  it("can still be switched off by an override, so a regression can be contained", () => {
    // The kill switch has to work in the on direction too: if a delivery or backup defect is found,
    // turning the type off must stop staging and serving without a code change to every call site.
    expect(attachmentTypeEnabled("baby_photo", { baby_photo: false })).toBe(false);
    expect(attachmentTypeEnabled("feed_photo", { baby_photo: false })).toBe(true);
  });

  it("keeps a profile picture to one per baby, smaller than a feed photo", () => {
    const policy = attachmentPolicy.baby_photo;

    // A baby has exactly one current picture; the partial unique index enforces the same thing
    // in the database.
    expect(policy.maxPerParent).toBe(1);
    // A profile picture is displayed small, so it is stored small.
    expect(policy.maxDimension).toBe(512);
    expect(policy.maxDimension).toBeLessThan(attachmentPolicy.feed_photo.maxDimension);
  });

  it("re-encodes to JPEG so the stored bytes are never the uploaded original", () => {
    const policy = attachmentPolicy.baby_photo;

    // Re-encoding is what strips location and camera data. Serving the uploaded bytes would
    // publish a child's photo complete with the GPS coordinates it was taken at.
    expect(policy.outputMimeType).toBe("image/jpeg");
    expect(policy.acceptedFormats).toEqual(["jpeg", "png", "webp"]);
    // Detected from the bytes; a filename or declared type is never trusted.
    expect(policy.acceptedFormats).not.toContain("svg");
    expect(policy.acceptedFormats).not.toContain("gif");
  });

  it("guards decoding against a small file that is enormous in memory", () => {
    const policy = attachmentPolicy.baby_photo;

    expect(policy.maxInputPixels).toBe(attachmentPolicy.feed_photo.maxInputPixels);
    expect(policy.maxInputBytes).toBeLessThanOrEqual(attachmentPolicy.feed_photo.maxInputBytes);
    expect(policy.maxInputBytes).toBeGreaterThan(0);
  });

  it("gives every declared type a policy entry", () => {
    for (const type of attachmentTypes) {
      const policy = attachmentPolicy[type as AttachmentTypeName];
      expect(policy, `missing policy for ${type}`).toBeDefined();
      expect(policy.outputMimeType).toBe("image/jpeg");
      expect(policy.maxPerParent).toBeGreaterThan(0);
    }
  });

  it("honours an explicit override in either direction", () => {
    expect(attachmentTypeEnabled("baby_photo", { baby_photo: true })).toBe(true);
    expect(attachmentTypeEnabled("baby_photo", {})).toBe(true);
  });
});
