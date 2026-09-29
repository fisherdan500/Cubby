import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import * as validation from "./thumbnail-validation";
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ directory: "", findFirst: vi.fn(), updateMany: vi.fn(), requirePermission: vi.fn() }));
vi.mock("@/lib/env", () => ({ attachmentConfig: { get directory() { return m.directory; } } }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { attachment: { findFirst: m.findFirst, updateMany: m.updateMany }, $transaction: async (work: (tx: unknown) => unknown) => work({ attachment: { updateMany: m.updateMany } }), auditEvent: { findFirst: async () => ({ id: "viewed" }) } } }));
vi.mock("@/server/auth/context", () => ({ getEffectiveHouseholdContext: async () => ({ householdId: "family", memberId: "member" }), requirePermission: m.requirePermission }));
vi.mock("@/server/services/browser-operations", () => ({}));
vi.mock("@/server/services/audit", () => ({ writeAudit: vi.fn() }));
import { openAttachment } from "./attachments";
import { writeAttachmentObject, writeAttachmentThumbnail } from "./attachment-store";


beforeEach(() => { vi.clearAllMocks(); m.updateMany.mockResolvedValue({ count: 1 }); });

it.each([false, true])("serves overlapping cached reads with verified fallback (damaged original: %s)", async (damaged) => {
  m.directory = await mkdtemp(path.join(os.tmpdir(), "cubby-thumbnail-contention-"));
  const keys = ["02".repeat(16), "03".repeat(16)];
  const original = await sharp({ create: { width: 32, height: 24, channels: 3, background: "blue" } }).jpeg().toBuffer();
  const expected = { byteSize: original.length, sha256: createHash("sha256").update(original).digest("hex") };
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const validate = validation.validateThumbnailInChild;
  const spy = vi.spyOn(validation, "validateThumbnailInChild").mockImplementationOnce(async (bytes) => {
    entered();
    await held;
    return validate(bytes);
  });
  let first: ReturnType<typeof openAttachment> | undefined;
  try {
    for (const key of keys) {
      await writeAttachmentObject(m.directory, key, original, expected);
      await writeAttachmentThumbnail(m.directory, key, original);
    }
    m.findFirst.mockImplementation(async ({ where }) => ({ id: where.id, type: "feed_photo", storageKey: keys[where.id === "first" ? 0 : 1], ...expected, mimeType: "image/jpeg" }));
    if (damaged) await writeFile(path.join(m.directory, "objects", "03", keys[1]), Buffer.alloc(original.length));
    first = openAttachment("first", { size: "thumbnail" });
    await ready;
    const second = openAttachment("second", { size: "thumbnail" });
    if (damaged) {
      await expect(second).rejects.toThrow("not_found");
      expect(m.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: "unavailable" }) }));
    } else {
      await expect(second).resolves.toMatchObject({ bytes: original });
      expect(m.updateMany).not.toHaveBeenCalled();
    }
    expect(spy).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toMatchObject({ bytes: original });
  } finally {
    release();
    await first?.catch(() => undefined);
    spy.mockRestore();
    await rm(m.directory, { recursive: true, force: true });
  }
});

it("rebuilds corrupt cached pixels from the verified original and reuses the persistent repair", async () => {
  m.directory = await mkdtemp(path.join(os.tmpdir(), "cubby-thumbnail-repair-"));
  const key = "01".repeat(16);
  try {
    const original = await sharp({ create: { width: 900, height: 600, channels: 3, background: "red" } }).jpeg().toBuffer();
    const expected = { byteSize: original.length, sha256: createHash("sha256").update(original).digest("hex") };
    await writeAttachmentObject(m.directory, key, original, expected);
    await writeAttachmentThumbnail(m.directory, key, Buffer.from("corrupt"));
    m.findFirst.mockResolvedValue({ id: "photo", type: "feed_photo", storageKey: key, ...expected, mimeType: "image/jpeg" });
    const first = await openAttachment("photo", { size: "thumbnail" });
    // No version was offered, so bytes are always served. Asserting that rather than casting keeps the
    // test honest about which branch of the conditional delivery it is exercising.
    expect(first.notModified).toBe(false);
    if (!first.bytes) throw new Error("expected thumbnail bytes");
    expect((await sharp(first.bytes).metadata()).width).toBe(800);
    expect(await readFile(path.join(m.directory, "thumbnails", "01", key))).toEqual(first.bytes);
    expect(await readFile(path.join(m.directory, "objects", "01", key))).toEqual(original);
    // Cached reads are independent of original integrity: this deliberate damage would fail a regeneration.
    await writeFile(path.join(m.directory, "objects", "01", key), "damaged original");
    const second = await openAttachment("photo", { size: "thumbnail" });
    expect(second.bytes).toEqual(first.bytes);
    expect(m.updateMany).not.toHaveBeenCalled();
    expect(m.requirePermission).toHaveBeenCalledTimes(2);
    expect(m.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ householdId: "family", state: "available" }) }));
  } finally {
    await rm(m.directory, { recursive: true, force: true });
  }
});
