// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every view of a photo re-reads the file from disk and re-hashes it to check it against its record, then
// sends the whole thing again. Scrolling a Moment back and forth pays that repeatedly for bytes the browser
// already has.
//
// A photo's bytes never change: `Attachment.sha256` is recorded at upload and the file is verified against
// it, so it is exactly the validator a conditional request needs. When the caller already holds that
// version, there is nothing to send.
//
// What must NOT change is authorization. DEC-PROD-144 (DISC-Q-0241) requires per-request household and
// resource reauthorization, so the household context, permission, and the availability of the post and
// baby are all resolved BEFORE the digest is compared, exactly as when bytes are served. A caller holding
// a correct digest for a photo they may no longer see must be refused, not answered.

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  requirePermission: vi.fn(),
  findFirst: vi.fn(),
  auditFindFirst: vi.fn(),
  writeAudit: vi.fn(),
  readObject: vi.fn(),
  readThumbnail: vi.fn(),
  writeThumbnail: vi.fn(),
  buildThumbnail: vi.fn()
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.context,
  requirePermission: mocks.requirePermission
}));
vi.mock("@/lib/env", () => ({ attachmentConfig: { directory: "/tmp/attachments" } }));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    attachment: { findFirst: mocks.findFirst, updateMany: vi.fn() },
    auditEvent: { findFirst: mocks.auditFindFirst },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ attachment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } }))
  }
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/server/services/attachment-store", () => ({
  readAttachmentObject: mocks.readObject,
  readAttachmentThumbnail: mocks.readThumbnail,
  removeAttachmentObject: vi.fn(),
  removeAttachmentThumbnail: vi.fn(),
  writeAttachmentObject: vi.fn(),
  writeAttachmentThumbnail: mocks.writeThumbnail
}));
vi.mock("@/server/services/feed-photo-processing", () => ({
  makeFeedPhotoThumbnail: mocks.buildThumbnail,
  processFeedPhoto: vi.fn()
}));
vi.mock("@/server/services/browser-operations", () => ({ getBrowserOperationContextForHousehold: vi.fn() }));
vi.mock("@/server/services/photo-write-actor", () => ({ lockPhotoWriteActor: vi.fn() }));
vi.mock("@/server/services/attachment-write-intent", () => ({
  withPhotoWriteOwnership: vi.fn(),
  lockPhotoWriteIntent: vi.fn(),
  transferPhotoWriteIntent: vi.fn(),
  settledPhotoTransaction: vi.fn()
}));

const DIGEST = "a".repeat(64);
const record = {
  id: "att-1",
  type: "feed_photo",
  storageKey: "key-1",
  byteSize: 4,
  sha256: DIGEST,
  mimeType: "image/jpeg"
};

beforeEach(() => {
  mocks.context.mockResolvedValue({ householdId: "house-1", userId: "user-1", memberId: "member-1", role: "parent" });
  mocks.findFirst.mockResolvedValue(record);
  mocks.auditFindFirst.mockResolvedValue({ id: "seen-today" });
  mocks.readObject.mockResolvedValue(Buffer.from("jpeg"));
  mocks.readThumbnail.mockResolvedValue(Buffer.from("small"));
  // Reset explicitly: a test that makes this throw would otherwise leak into every later test, and
  // `clearAllMocks` clears calls but keeps the implementation.
  mocks.requirePermission.mockImplementation(() => undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("openAttachment conditional delivery", () => {
  it("reports the version alongside the bytes, so a caller can ask again cheaply", async () => {
    const { openAttachment } = await import("./attachments");
    await expect(openAttachment("att-1")).resolves.toEqual({
      bytes: Buffer.from("jpeg"),
      mimeType: "image/jpeg",
      digest: DIGEST,
      notModified: false
    });
  });

  it("gives a thumbnail its own version, so the two copies cannot be confused", async () => {
    const { openAttachment } = await import("./attachments");
    const full = await openAttachment("att-1");
    const thumb = await openAttachment("att-1", { size: "thumbnail" });

    // Same photo, different bytes. Sharing one validator would let a browser reuse the small copy as the
    // large one, or the reverse.
    expect(thumb.digest).not.toBe(full.digest);
    expect(thumb.digest).toContain(DIGEST);
  });

  it("answers a matching digest without reading or hashing the file", async () => {
    const { openAttachment } = await import("./attachments");
    const result = await openAttachment("att-1", { knownDigests: [DIGEST] });

    expect(result).toEqual({ bytes: null, mimeType: "image/jpeg", digest: DIGEST, notModified: true });
    // The expensive half: the read is what verifies the file against its hash.
    expect(mocks.readObject).not.toHaveBeenCalled();
  });

  it("serves the bytes when the caller's version is stale or absent", async () => {
    const { openAttachment } = await import("./attachments");
    await expect(openAttachment("att-1", { knownDigests: ["b".repeat(64)] })).resolves.toMatchObject({
      bytes: Buffer.from("jpeg"),
      notModified: false
    });
    expect(mocks.readObject).toHaveBeenCalledTimes(1);
  });

  it("checks the household and permission BEFORE honouring a digest", async () => {
    const { openAttachment } = await import("./attachments");
    mocks.requirePermission.mockImplementation(() => {
      throw new Error("forbidden");
    });

    // A correct digest must not become a way past authorization.
    await expect(openAttachment("att-1", { knownDigests: [DIGEST] })).rejects.toThrow("forbidden");
  });

  it("refuses a digest for a photo this household can no longer see", async () => {
    const { openAttachment } = await import("./attachments");
    // Removed post, deleted baby, foreign household, switched-off type: all resolve to no record.
    mocks.findFirst.mockResolvedValue(null);

    await expect(openAttachment("att-1", { knownDigests: [DIGEST] })).rejects.toThrow("not_found");
  });

  it("still records the view when nothing is sent", async () => {
    const { openAttachment } = await import("./attachments");
    mocks.auditFindFirst.mockResolvedValue(null);
    await openAttachment("att-1", { knownDigests: [DIGEST] });

    // The photo was looked at. That it arrived from the browser's own store does not make it unviewed.
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "attachment.view", entityId: "att-1" })
    );
  });
});
