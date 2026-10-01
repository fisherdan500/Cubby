/**
 * A member setting their own profile picture, against real PostgreSQL.
 *
 * The unit tests mock the service; this calls it for real with real image bytes and lets every
 * side effect happen: image processing, storage, the attachment row, the audit event, and the
 * membership ownership that keeps one household's picture out of another.
 *
 * This gate exists because the baby-photo equivalent shipped broken behind a fully green suite:
 * every service test mocked writeAudit, so nothing ever wrote the audit row that the schema
 * rejected. A profile picture must not repeat that.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const prisma = new PrismaClient();
const storageDir = mkdtempSync(join(tmpdir(), "cubby-profile-photo-"));
process.env.ATTACHMENT_DIRECTORY = storageDir;

const householdId = `h-${randomUUID()}`;
const otherHouseholdId = `h-${randomUUID()}`;
const userId = `u-${randomUUID()}`;
let memberId = "";
let otherMemberId = "";
let sessionId = "";

vi.mock("@/server/auth/context", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/server/auth/context");
  return {
    ...actual,
    getEffectiveHouseholdContext: async () => ({
      householdId, userId, memberId, role: "caretaker",
      permissions: ["session.manage", "activity.read"]
    })
  };
});

vi.mock("@/server/services/browser-operations", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/server/services/browser-operations");
  return {
    ...actual,
    getBrowserOperationContextForHousehold: async () => ({
      householdId, userId, memberId, role: "caretaker",
      permissions: ["session.manage", "activity.read"],
      sessionId
    })
  };
});

const jpeg = async () =>
  await sharp({ create: { width: 500, height: 500, channels: 3, background: { r: 90, g: 140, b: 190 } } })
    .jpeg()
    .toBuffer();

beforeAll(async () => {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, name: "Caretaker", emailVerified: true } });
  await prisma.household.create({ data: { id: householdId, name: "Profile House", createdByUserId: userId } });
  await prisma.household.create({ data: { id: otherHouseholdId, name: "Other House", createdByUserId: userId } });
  memberId = (await prisma.householdMember.create({ data: { householdId, userId, role: "caretaker", joinedAt: new Date() } })).id;
  // The same person in a second household: their picture there must stay separate.
  otherMemberId = (await prisma.householdMember.create({
    data: { householdId: otherHouseholdId, userId, role: "caretaker", joinedAt: new Date() }
  })).id;
  sessionId = (await prisma.session.create({
    data: { userId, token: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) }
  })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a member setting their own picture", () => {
  it("stages and claims it onto their own membership", async () => {
    const { stageUserPhoto, claimStagedUserPhoto } = await import("@/server/services/attachments");

    const staged = await stageUserPhoto(await jpeg());
    const claimed = await claimStagedUserPhoto(staged.attachmentId);

    expect(claimed.attachmentId).toBe(staged.attachmentId);
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: staged.attachmentId } });
    expect([row.type, row.state, row.memberId, row.householdId]).toEqual(["user_photo", "available", memberId, householdId]);
  });

  it("writes an audit event the schema accepts", async () => {
    // The exact failure that reached a family on baby photos.
    const audit = await prisma.auditEvent.findFirst({
      where: { householdId, action: "attachment.stage" },
      orderBy: { createdAt: "desc" }
    });
    expect(audit?.after).toMatchObject({ type: "user_photo" });
  });

  it("retires the previous picture when a new one replaces it", async () => {
    const { stageUserPhoto, claimStagedUserPhoto } = await import("@/server/services/attachments");
    const before = await prisma.attachment.findFirstOrThrow({
      where: { householdId, memberId, type: "user_photo", state: "available" }
    });

    const staged = await stageUserPhoto(await jpeg());
    await claimStagedUserPhoto(staged.attachmentId);

    const retired = await prisma.attachment.findUniqueOrThrow({ where: { id: before.id } });
    expect(retired.state).not.toBe("available");
    // Exactly one available picture per membership, enforced by the partial unique index.
    const available = await prisma.attachment.count({
      where: { householdId, memberId, type: "user_photo", state: "available" }
    });
    expect(available).toBe(1);
  });

  it("keeps the picture out of the member's other household", async () => {
    // A picture belongs to a membership, not a user: the same person elsewhere has none.
    const elsewhere = await prisma.attachment.count({
      where: { householdId: otherHouseholdId, memberId: otherMemberId, type: "user_photo", state: "available" }
    });
    expect(elsewhere).toBe(0);
  });

  it("is the picture the member's own page would show", async () => {
    const { getOwnProfilePhoto } = await import("@/server/services/profile-photo");
    const current = await prisma.attachment.findFirstOrThrow({
      where: { householdId, memberId, type: "user_photo", state: "available" }
    });

    expect(await getOwnProfilePhoto()).toEqual({ photoAttachmentId: current.id });
  });

  it("strips camera metadata from what it stores", async () => {
    const { stageUserPhoto } = await import("@/server/services/attachments");
    const withExif = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: "someone", Software: "a phone" } } })
      .toBuffer();

    const staged = await stageUserPhoto(withExif);
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id: staged.attachmentId } });
    const { readAttachmentObject } = await import("@/server/services/attachment-store");
    const stored = await readAttachmentObject(storageDir, row.storageKey, { byteSize: row.byteSize, sha256: row.sha256 });

    expect((await sharp(stored).metadata()).exif).toBeUndefined();
  });

  it("refuses bytes that are not a picture", async () => {
    const { stageUserPhoto } = await import("@/server/services/attachments");
    await expect(stageUserPhoto(Buffer.from("not an image"))).rejects.toThrow();
  });
});
