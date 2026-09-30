import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  browserContext: vi.fn(),
  attachmentCreate: vi.fn(),
  attachmentFindMany: vi.fn(),
  attachmentUpdateMany: vi.fn(),
  babyFindFirst: vi.fn(),
  lockRaw: vi.fn(),
  writeAudit: vi.fn(),
  processPhoto: vi.fn(),
  writeObject: vi.fn(),
  lockActor: vi.fn(),
  lockIntent: vi.fn(),
  transferIntent: vi.fn(),
  reserve: vi.fn()
}));

vi.mock("@/server/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/context")>();
  return { ...actual, getEffectiveHouseholdContext: mocks.context };
});
vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForHousehold: mocks.browserContext
}));
vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));
vi.mock("@/server/services/photo-write-actor", () => ({ lockPhotoWriteActor: mocks.lockActor }));
vi.mock("@/server/services/attachment-write-intents", () => ({
  withPhotoWriteOwnership: async (work: (reserve: unknown) => Promise<unknown>) => work(mocks.reserve),
  settledPhotoTransaction: async (work: (tx: unknown) => Promise<unknown>) => work(transactionClient()),
  lockPhotoWriteIntent: mocks.lockIntent,
  transferPhotoWriteIntent: mocks.transferIntent
}));
vi.mock("@/server/services/feed-photo-processing", () => ({
  processAttachmentPhoto: mocks.processPhoto,
  processFeedPhoto: mocks.processPhoto,
  makeFeedPhotoThumbnail: vi.fn()
}));
vi.mock("@/server/services/attachment-store", () => ({
  writeAttachmentObject: mocks.writeObject,
  readAttachmentObject: vi.fn(),
  readAttachmentThumbnail: vi.fn(),
  removeAttachmentObject: vi.fn(),
  removeAttachmentThumbnail: vi.fn(),
  writeAttachmentThumbnail: vi.fn()
}));

function transactionClient() {
  return {
    $queryRaw: mocks.lockRaw,
    attachment: {
      create: mocks.attachmentCreate,
      findMany: mocks.attachmentFindMany,
      updateMany: mocks.attachmentUpdateMany
    },
    baby: { findFirst: mocks.babyFindFirst }
  };
}

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(transactionClient())
  }
}));

import { claimStagedBabyPhoto, stageBabyPhoto } from "@/server/services/attachments";

const OWNER = { householdId: "household-1", userId: "user-1", memberId: "member-1", sessionId: "session-1", role: "owner" as const };
const PHOTO = {
  bytes: Buffer.from("jpeg-bytes"),
  byteSize: 10,
  sha256: "a".repeat(64),
  mimeType: "image/jpeg" as const,
  width: 512,
  height: 512
};

beforeEach(() => {
  vi.clearAllMocks();
  // The plain household context genuinely has no sessionId; keep the mocks distinguishable.
  mocks.context.mockResolvedValue({ householdId: "household-1", userId: "user-1", memberId: "member-1", role: "owner" });
  mocks.browserContext.mockResolvedValue(OWNER);
  mocks.lockActor.mockResolvedValue(OWNER);
  mocks.processPhoto.mockResolvedValue(PHOTO);
  mocks.reserve.mockResolvedValue("b".repeat(32));
  mocks.attachmentCreate.mockResolvedValue({ id: "attachment-1" });
  mocks.attachmentFindMany.mockResolvedValue([]);
  mocks.attachmentUpdateMany.mockResolvedValue({ count: 1 });
  mocks.babyFindFirst.mockResolvedValue({ id: "baby-1", householdId: "household-1", deletedAt: null });
});

describe("staging a baby photo", () => {
  it("requires baby.manage, not feed.post", async () => {
    // A caretaker holds feed.post but NOT baby.manage. Gating this on feed.post - the permission the
    // feed photo path uses - would let a babysitter change a child's identity photo.
    mocks.browserContext.mockResolvedValue({ ...OWNER, role: "caretaker" });

    await expect(stageBabyPhoto(Buffer.from("x"), { enabled: { baby_photo: true } }))
      .rejects.toThrow("forbidden");

    expect(mocks.attachmentCreate).not.toHaveBeenCalled();
    expect(mocks.writeObject).not.toHaveBeenCalled();
  });

  it("refuses while the type is switched off", async () => {
    // The type ships enabled now that all four gates pass, so the switch is exercised explicitly:
    // turning it off must stop staging, which is how a delivery or backup regression gets contained.
    await expect(stageBabyPhoto(Buffer.from("x"), { enabled: { baby_photo: false } }))
      .rejects.toThrow("attachment_type_unavailable");

    expect(mocks.attachmentCreate).not.toHaveBeenCalled();
    expect(mocks.writeObject).not.toHaveBeenCalled();
  });

  it("stages with no parent, because the claim step sets it", async () => {
    await stageBabyPhoto(Buffer.from("x"), { enabled: { baby_photo: true } });

    const created = mocks.attachmentCreate.mock.calls[0][0];
    expect(created.data.type).toBe("baby_photo");
    expect(created.data.babyId).toBeUndefined();
    expect(created.data.postId).toBeUndefined();
    expect(created.data.householdId).toBe("household-1");
  });

  it("re-checks the permission inside the write transaction", async () => {
    // The role can change between the request check and the commit. The feed path re-checks against
    // a locked actor row; this must too, or a demoted member's upload still lands.
    mocks.lockActor.mockResolvedValue({ ...OWNER, role: "caretaker" });

    await expect(stageBabyPhoto(Buffer.from("x"), { enabled: { baby_photo: true } }))
      .rejects.toThrow("forbidden");
  });
});

describe("claiming a staged baby photo", () => {
  it("requires baby.manage inside the transaction", async () => {
    mocks.lockActor.mockResolvedValue({ ...OWNER, role: "caretaker" });

    await expect(claimStagedBabyPhoto("attachment-1", "baby-1", { enabled: { baby_photo: true } }))
      .rejects.toThrow("forbidden");

    expect(mocks.attachmentUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses a baby that is hidden or in another household", async () => {
    mocks.babyFindFirst.mockResolvedValue(null);

    await expect(claimStagedBabyPhoto("attachment-1", "baby-1", { enabled: { baby_photo: true } }))
      .rejects.toThrow("not_found");

    expect(mocks.attachmentUpdateMany).not.toHaveBeenCalled();
  });

  it("looks the baby up scoped to this household and excludes hidden babies", async () => {
    await claimStagedBabyPhoto("attachment-1", "baby-1", { enabled: { baby_photo: true } });

    expect(mocks.babyFindFirst).toHaveBeenCalledWith({
      where: { id: "baby-1", householdId: "household-1", deletedAt: null },
      select: { id: true }
    });
  });

  it("retires the previous photo in the same transaction as the new one goes live", async () => {
    // Two live photos for one baby would violate the partial unique index, so the retirement and the
    // activation must be one transaction - and the old row must keep its recovery window.
    mocks.attachmentFindMany.mockResolvedValue([{ id: "old-attachment" }]);

    await claimStagedBabyPhoto("attachment-1", "baby-1", { enabled: { baby_photo: true } });

    const retire = mocks.attachmentUpdateMany.mock.calls.find(
      (call) => call[0].data.state === "deleted"
    );
    expect(retire, "the previous photo must be retired").toBeDefined();
    expect(retire?.[0].where).toEqual({
      id: "old-attachment",
      householdId: "household-1",
      state: "available"
    });
    expect(retire?.[0].data.deletedAt).toBeInstanceOf(Date);
    expect(retire?.[0].data.purgeAfter).toBeInstanceOf(Date);
  });

  it("activates the staged photo scoped to this household and this member", async () => {
    await claimStagedBabyPhoto("attachment-1", "baby-1", { enabled: { baby_photo: true } });

    const activate = mocks.attachmentUpdateMany.mock.calls.find(
      (call) => call[0].data.state === "available"
    );
    expect(activate?.[0].where).toEqual({
      id: "attachment-1",
      householdId: "household-1",
      type: "baby_photo",
      state: "staging",
      createdByMemberId: "member-1"
    });
    expect(activate?.[0].data.babyId).toBe("baby-1");
    expect(activate?.[0].data.activatedAt).toBeInstanceOf(Date);
  });

  it("locks before it reads the photo it is about to replace", async () => {
    mocks.attachmentFindMany.mockResolvedValue([{ id: "old-attachment" }]);

    await claimStagedBabyPhoto("attachment-1", "baby-1", { enabled: { baby_photo: true } });

    // Without the lock first, two concurrent replacements both see no predecessor and both activate.
    expect(mocks.lockRaw.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.attachmentFindMany.mock.invocationCallOrder[0]);
  });

  it("locks the actor against the session the request arrived on", async () => {
    // lockPhotoWriteActor pins the session row as well as the membership, so the claim needs a
    // context carrying a sessionId. The plain household context has none, and using it means the
    // actor lock silently has nothing to lock.
    await claimStagedBabyPhoto("attachment-1", "baby-1", { enabled: { baby_photo: true } });

    expect(mocks.browserContext).toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.lockActor.mock.calls[0][1]).toHaveProperty("sessionId");
  });

  it("records the claim without naming the file", async () => {
    await claimStagedBabyPhoto("attachment-1", "baby-1", { enabled: { baby_photo: true } });

    const [, event] = mocks.writeAudit.mock.calls.at(-1) ?? [];
    expect(event.action).toBe("attachment.activate");
    expect(event.entityType).toBe("baby");
    expect(event.entityId).toBe("baby-1");
    expect(event.after).toEqual({ type: "baby_photo" });
  });
});
