/**
 * A real photo upload, through the real service, against real PostgreSQL.
 *
 * This gate exists because a defect reached production that every other gate was structurally
 * incapable of catching. The audit payload schema accepted only "feed_photo", so staging a baby
 * photo threw a ZodError and the family saw "Please check the highlighted fields." The unit suites
 * all mock writeAudit, and the catalog gates only exercise Prisma writes directly, so nothing ever
 * called stageBabyPhoto and let the audit row actually be written.
 *
 * So this calls the service functions themselves with real image bytes and lets every side effect
 * happen for real: image processing, storage, the attachment row, and the audit event.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const prisma = new PrismaClient();
const storageDir = mkdtempSync(join(tmpdir(), "cubby-upload-gate-"));

const householdId = `h-${randomUUID()}`;
const userId = `u-${randomUUID()}`;
let memberId = "";
let babyId = "";

// The real service reads its storage root and its household context from the environment it runs
// in, so both are pointed at disposable equivalents rather than stubbed out.
process.env.ATTACHMENT_DIRECTORY = storageDir;

vi.mock("@/server/auth/context", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/server/auth/context");
  return {
    ...actual,
    getEffectiveHouseholdContext: async () => ({
      householdId, userId, memberId, role: "owner", permissions: ["baby.manage", "feed.post", "session.manage"]
    })
  };
});

let sessionId = "";

vi.mock("@/server/services/browser-operations", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/server/services/browser-operations");
  return {
    ...actual,
    // Only the session lookup is replaced; the real function also verifies the signed-in user, which
    // needs a request. Everything downstream - including locking the real session row - still runs.
    getBrowserOperationContextForHousehold: async () => ({
      householdId, userId, memberId, role: "owner",
      permissions: ["baby.manage", "feed.post", "session.manage"],
      sessionId
    })
  };
});

async function jpegBytes(): Promise<Buffer> {
  return await sharp({ create: { width: 600, height: 600, channels: 3, background: { r: 120, g: 160, b: 200 } } })
    .jpeg()
    .toBuffer();
}

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, name: "Parent", emailVerified: true } });
  await prisma.household.create({ data: { id: householdId, name: "Upload Gate House", createdByUserId: userId } });
  const member = await prisma.householdMember.create({
    data: { householdId, userId, role: "owner", joinedAt: new Date() }
  });
  memberId = member.id;
  const baby = await prisma.baby.create({ data: { householdId, name: "Gate Baby", timezone: "UTC" } });
  babyId = baby.id;
  // A real, unexpired session: the photo write path locks this row, which is what stops a photo
  // being written by a session that has since been revoked.
  const session = await prisma.session.create({
    data: {
      userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    }
  });
  sessionId = session.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("uploading a real picture through the real service", () => {
  it("stages a baby photo and writes its audit event", async () => {
    // The exact path that failed in production: staging wrote an audit row the schema refused.
    const { stageBabyPhoto } = await import("@/server/services/attachments");

    const staged = await stageBabyPhoto(await jpegBytes());

    expect(staged.attachmentId).toBeTruthy();
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: staged.attachmentId } });
    expect([row.type, row.state]).toEqual(["baby_photo", "staging"]);

    const audit = await prisma.auditEvent.findFirst({
      where: { householdId, entityId: staged.attachmentId, action: "attachment.stage" }
    });
    expect(audit).not.toBeNull();
    expect(audit?.after).toMatchObject({ type: "baby_photo" });
  });

  it("claims the staged photo onto the baby", async () => {
    const { stageBabyPhoto, claimStagedBabyPhoto } = await import("@/server/services/attachments");

    const staged = await stageBabyPhoto(await jpegBytes());
    const claimed = await claimStagedBabyPhoto(staged.attachmentId, babyId);

    expect(claimed.attachmentId).toBe(staged.attachmentId);
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: staged.attachmentId } });
    expect([row.state, row.babyId]).toEqual(["available", babyId]);

    const audit = await prisma.auditEvent.findFirst({
      where: { householdId, action: "attachment.activate", entityId: babyId }
    });
    expect(audit?.after).toMatchObject({ type: "baby_photo" });
  });

  it("stages a user photo and writes its audit event", async () => {
    // user_photo has no UI yet, so this is the only thing standing between the same defect and the
    // day its UI ships.
    const { stageUserPhoto } = await import("@/server/services/attachments");

    const staged = await stageUserPhoto(await jpegBytes());

    const audit = await prisma.auditEvent.findFirst({
      where: { householdId, entityId: staged.attachmentId, action: "attachment.stage" }
    });
    expect(audit?.after).toMatchObject({ type: "user_photo" });
  });

  it("strips camera metadata from what it stores", async () => {
    // A profile picture is the most likely attachment to be a camera original, and re-encoding is
    // what removes any embedded location.
    const { stageBabyPhoto } = await import("@/server/services/attachments");
    const withExif = await sharp({ create: { width: 600, height: 600, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: "somebody", Software: "a camera" } } })
      .toBuffer();

    const staged = await stageBabyPhoto(withExif);
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: staged.attachmentId } });

    const { readAttachmentObject } = await import("@/server/services/attachment-store");
    const stored = await readAttachmentObject(storageDir, row.storageKey, { byteSize: row.byteSize, sha256: row.sha256 });
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();
  });

  it("refuses bytes that are not an image the policy accepts", async () => {
    const { stageBabyPhoto } = await import("@/server/services/attachments");

    await expect(stageBabyPhoto(Buffer.from("this is not an image"))).rejects.toThrow();

    // The refusal is itself audited, and that audit row must be writable too.
    const audit = await prisma.auditEvent.findFirst({
      where: { householdId, action: "attachment.reject" },
      orderBy: { createdAt: "desc" }
    });
    expect(audit?.after).toMatchObject({ type: "baby_photo", reason: "unsupported_format" });
  });
});
