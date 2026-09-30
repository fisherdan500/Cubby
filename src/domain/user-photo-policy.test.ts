/**
 * The user_photo policy and its kill switch.
 *
 * The switch is the safety property here: the type stays off until storage, delivery, backup and
 * restore have all been proven, so a half-finished path can never accept a real person's photo.
 */
import { describe, expect, it } from "vitest";

import { attachmentPolicy, attachmentTypeEnabled } from "./attachments";

describe("the policy for a person's profile picture", () => {
  it("is switched on now that its whole gate has passed", () => {
    // DEC-PROD-070: a type is enabled only once storage, private delivery, recovery and backup have
    // all passed. All four are built and proven for user photos, so the type ships on. If any of
    // those paths is ever regressed, this flag is what must go back to false.
    expect(attachmentTypeEnabled("user_photo")).toBe(true);
  });

  it("can still be switched off by an override, so a regression can be contained", () => {
    // The kill switch has to work in the on direction too: if a delivery or backup defect is found,
    // turning the type off must stop staging and serving without a code change to every call site.
    expect(attachmentTypeEnabled("user_photo", { user_photo: false })).toBe(false);
    // Turning one type off must not disturb the others.
    expect(attachmentTypeEnabled("baby_photo", { user_photo: false })).toBe(true);
    expect(attachmentTypeEnabled("feed_photo", { user_photo: false })).toBe(true);
  });

  it("keeps one picture per person", () => {
    expect(attachmentPolicy.user_photo.maxPerParent).toBe(1);
  });

  it("re-encodes to JPEG, which is what strips EXIF location from a photo of a person", () => {
    // A profile picture is the most likely attachment to be a camera original, so the metadata
    // strip matters more here than anywhere else.
    expect(attachmentPolicy.user_photo.outputMimeType).toBe("image/jpeg");
    expect(attachmentPolicy.user_photo.acceptedFormats).toContain("jpeg");
  });

  it("bounds the stored size, so an avatar cannot be used to fill the disk", () => {
    expect(attachmentPolicy.user_photo.maxDimension).toBeLessThanOrEqual(512);
    expect(attachmentPolicy.user_photo.maxInputBytes).toBeLessThanOrEqual(attachmentPolicy.feed_photo.maxInputBytes);
  });

  it("does not disturb the types already in use", () => {
    expect(attachmentTypeEnabled("feed_photo")).toBe(true);
    expect(attachmentTypeEnabled("baby_photo")).toBe(true);
  });
});
