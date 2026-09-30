/**
 * Audit payloads for attachment events, against the real schema.
 *
 * This file exists because of a defect that reached production: the attachment audit payload
 * accepted only "feed_photo", so every baby and user photo upload threw a ZodError that surfaced to
 * the family as "Please check the highlighted fields." A full green suite missed it because every
 * service test mocks writeAudit, so the real schema never ran in a test.
 *
 * So these tests deliberately call the REAL audit payload validator with no mocking. If the audit
 * schema and the attachment types ever drift apart again, this is what fails.
 */
import { describe, expect, it } from "vitest";

import { attachmentTypes } from "@/domain/attachments";
import { minimizeAuditPayload } from "./audit";

// The real validator, called the way writeAudit calls it.
const auditPayloadForTest = (action: string, payload: Record<string, unknown>) =>
  minimizeAuditPayload(action as Parameters<typeof minimizeAuditPayload>[0], payload as never, "after");

const attachmentActions = [
  "attachment.stage",
  "attachment.activate",
  "attachment.delete",
  "attachment.restore",
  "attachment.view",
  "attachment.purge",
  "attachment.reject",
  "attachment.unavailable"
] as const;

describe("what an attachment audit event may carry", () => {
  it.each([...attachmentTypes])("accepts a staged %s, because every enabled type is uploadable", (type) => {
    expect(() => auditPayloadForTest("attachment.stage", { type })).not.toThrow();
  });

  it.each([...attachmentTypes])("accepts a viewed %s, because delivery audits whatever it served", (type) => {
    // openAttachment writes the attachment's own type, so a type it cannot audit is a type it
    // cannot serve.
    expect(() => auditPayloadForTest("attachment.view", { type })).not.toThrow();
  });

  it("accepts every attachment action for every type", () => {
    // The router sends all attachment.* actions through one payload schema, so a type that works
    // for staging but not for purging would still break a background job later.
    for (const action of attachmentActions) {
      for (const type of attachmentTypes) {
        expect(() => auditPayloadForTest(action, { type })).not.toThrow();
      }
    }
  });

  it("covers the whole attachment type list, not a copy of it", () => {
    // Guards against this test passing while a newly added type is quietly left out: the cases above
    // are generated from the domain list itself, so a new type must be accepted or this file fails.
    expect(attachmentTypes.length).toBeGreaterThanOrEqual(3);
    expect([...attachmentTypes]).toEqual(expect.arrayContaining(["feed_photo", "baby_photo", "user_photo"]));
  });

  it("still refuses a type that is not an attachment type at all", () => {
    expect(() => auditPayloadForTest("attachment.stage", { type: "passport_scan" })).toThrow();
  });

  it("still refuses anything the uploader supplied", () => {
    // DEC-PROD-147: an attachment audit carries the type, safe counts and a fixed reason - never a
    // filename, path, checksum, size or raw bytes. Widening the type list must not have relaxed it.
    expect(() => auditPayloadForTest("attachment.stage", { type: "baby_photo", filename: "baby.jpg" })).toThrow();
    expect(() => auditPayloadForTest("attachment.stage", { type: "baby_photo", sha256: "a".repeat(64) })).toThrow();
    expect(() => auditPayloadForTest("attachment.stage", { type: "baby_photo", byteSize: 2048 })).toThrow();
    expect(() => auditPayloadForTest("attachment.stage", { type: "baby_photo", storageKey: "0".repeat(32) })).toThrow();
  });

  it("keeps the reason list fixed", () => {
    expect(() => auditPayloadForTest("attachment.reject", { type: "baby_photo", reason: "unsupported_format" })).not.toThrow();
    expect(() => auditPayloadForTest("attachment.purge", { type: "user_photo", reason: "expired" })).not.toThrow();
    // A free-text reason could carry family detail, so only the fixed vocabulary is allowed.
    expect(() => auditPayloadForTest("attachment.reject", { type: "baby_photo", reason: "looked wrong to me" })).toThrow();
  });
});
