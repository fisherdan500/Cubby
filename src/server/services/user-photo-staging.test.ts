/**
 * Staging and claiming a person's own profile picture.
 *
 * The authorisation rule here is deliberately different from a baby's. A baby's picture is
 * household data, gated on baby.manage. A person's own picture is self-service: every role, down to
 * read_only, may set their OWN, and nobody may set anybody else's. So there is no new permission -
 * the claim is constrained to the acting member's own membership row, which is the only thing that
 * makes "own" meaningful.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBrowserOperationContextForHousehold: vi.fn(),
  requirePermission: vi.fn(),
  processAttachmentPhoto: vi.fn(),
  writeAttachmentObject: vi.fn(),
  writeAudit: vi.fn(),
  lockPhotoWriteActor: vi.fn(),
  lockPhotoWriteIntent: vi.fn(),
  transferPhotoWriteIntent: vi.fn(),
  withPhotoWriteOwnership: vi.fn(),
  settledPhotoTransaction: vi.fn(),
  attachmentCreate: vi.fn(),
  attachmentUpdateMany: vi.fn(),
  attachmentFindMany: vi.fn(),
  memberFindFirst: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn()
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    attachment: { create: mocks.attachmentCreate, updateMany: mocks.attachmentUpdateMany, findMany: mocks.attachmentFindMany },
    householdMember: { findFirst: mocks.memberFindFirst }
  }
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: mocks.requirePermission
}));

vi.mock("@/server/services/browser-operations", () => ({
  getBrowserOperationContextForHousehold: mocks.getBrowserOperationContextForHousehold
}));

vi.mock("@/server/services/audit", () => ({ writeAudit: mocks.writeAudit }));

vi.mock("@/server/services/feed-photo-processing", () => ({
  processAttachmentPhoto: mocks.processAttachmentPhoto,
  processFeedPhoto: vi.fn(),
  makeFeedPhotoThumbnail: vi.fn(),
  rejectionReason: () => "unreadable"
}));

vi.mock("@/server/services/photo-write-actor", () => ({
  lockPhotoWriteActor: mocks.lockPhotoWriteActor
}));

vi.mock("@/server/services/attachment-write-intents", () => ({
  withPhotoWriteOwnership: mocks.withPhotoWriteOwnership,
  lockPhotoWriteIntent: mocks.lockPhotoWriteIntent,
  transferPhotoWriteIntent: mocks.transferPhotoWriteIntent,
  settledPhotoTransaction: mocks.settledPhotoTransaction
}));

vi.mock("@/server/services/attachment-store", () => ({
  writeAttachmentObject: mocks.writeAttachmentObject,
  writeAttachmentThumbnail: vi.fn(),
  readAttachmentObject: vi.fn(),
  readAttachmentThumbnail: vi.fn(),
  removeAttachmentObject: vi.fn(),
  removeAttachmentThumbnail: vi.fn()
}));

const { stageUserPhoto, claimStagedUserPhoto } = await import("./attachments");

const ctx = { householdId: "household-1", memberId: "member-1", sessionId: "session-1", userId: "user-1", role: "read_only" };
const photo = { bytes: Buffer.from("jpeg"), byteSize: 4, sha256: "a".repeat(64), mimeType: "image/jpeg", width: 512, height: 512 };
const enabled = { user_photo: true };

let tx: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBrowserOperationContextForHousehold.mockResolvedValue(ctx);
  mocks.requirePermission.mockReturnValue(undefined);
  mocks.processAttachmentPhoto.mockResolvedValue(photo);
  mocks.lockPhotoWriteActor.mockImplementation(async () => ctx);
  mocks.attachmentCreate.mockResolvedValue({ id: "att-1" });
  mocks.attachmentFindMany.mockResolvedValue([]);
  mocks.attachmentUpdateMany.mockResolvedValue({ count: 1 });
  mocks.memberFindFirst.mockResolvedValue({ id: "member-1" });
  mocks.withPhotoWriteOwnership.mockImplementation(async (work: (reserve: unknown) => Promise<unknown>) =>
    work(async () => "objects/att-1.jpg"));
  mocks.settledPhotoTransaction.mockImplementation(async (work: (t: unknown) => Promise<unknown>) => work(tx));
  tx = {
    attachment: { create: mocks.attachmentCreate, updateMany: mocks.attachmentUpdateMany, findMany: mocks.attachmentFindMany },
    householdMember: { findFirst: mocks.memberFindFirst },
    $queryRaw: mocks.queryRaw
  };
  mocks.transaction.mockImplementation(async (work: (t: unknown) => Promise<unknown>) => work(tx));
});

describe("staging your own profile picture", () => {
  it("refuses when the type is switched off, so a regression can be contained", async () => {
    // The type ships on. What must keep working is the kill switch: turning it off has to stop the
    // upload before any bytes are written, without a code change at the call site.
    await expect(stageUserPhoto(Buffer.from("x"), { enabled: { user_photo: false } })).rejects.toThrow("attachment_type_unavailable");
    expect(mocks.attachmentCreate).not.toHaveBeenCalled();
    expect(mocks.writeAttachmentObject).not.toHaveBeenCalled();
  });

  it("stores the re-encoded picture with no owner yet", async () => {
    const result = await stageUserPhoto(Buffer.from("x"), { enabled });

    expect(result).toMatchObject({ attachmentId: "att-1" });
    const created = mocks.attachmentCreate.mock.calls[0][0].data;
    // Staged means owned by nobody: the claim sets the member.
    expect(created).toMatchObject({ householdId: "household-1", type: "user_photo", createdByMemberId: "member-1" });
    expect(created.memberId).toBeUndefined();
    expect(created.postId).toBeUndefined();
  });

  it("needs no extra permission, because setting your own picture is self-service", async () => {
    // Every role including read_only may set their own picture, so requiring baby.manage or
    // member.manage here would lock out exactly the people it is for.
    await stageUserPhoto(Buffer.from("x"), { enabled });

    const asked = mocks.requirePermission.mock.calls.map((call) => call[1]);
    expect(asked).not.toContain("baby.manage");
    expect(asked).not.toContain("member.manage");
  });

  it("re-encodes through the shared processor under the user policy", async () => {
    await stageUserPhoto(Buffer.from("x"), { enabled });

    expect(mocks.processAttachmentPhoto).toHaveBeenCalledWith(expect.any(Buffer), "user_photo");
  });
});

describe("claiming your own profile picture", () => {
  it("refuses when the type is switched off, so a regression can be contained", async () => {
    await expect(claimStagedUserPhoto("att-1", { enabled: { user_photo: false } })).rejects.toThrow("attachment_type_unavailable");
    expect(mocks.attachmentUpdateMany).not.toHaveBeenCalled();
  });

  it("claims the picture for the acting member's own membership", async () => {
    const result = await claimStagedUserPhoto("att-1", { enabled });

    expect(result).toMatchObject({ attachmentId: "att-1", memberId: "member-1" });
    const claim = mocks.attachmentUpdateMany.mock.calls.at(-1)![0];
    // The owner is the acting member, taken from the session context - never from an argument.
    expect(claim.data).toMatchObject({ state: "available", memberId: "member-1" });
    expect(claim.where).toMatchObject({
      id: "att-1",
      householdId: "household-1",
      type: "user_photo",
      state: "staging",
      createdByMemberId: "member-1"
    });
  });

  it("retires the previous picture in the same transaction, keeping its recovery window", async () => {
    mocks.attachmentFindMany.mockResolvedValue([{ id: "att-old" }]);

    await claimStagedUserPhoto("att-1", { enabled });

    const retire = mocks.attachmentUpdateMany.mock.calls[0][0];
    expect(retire.where).toMatchObject({ id: "att-old", state: "available" });
    expect(retire.data).toMatchObject({ state: "deleted" });
    // Recoverable, not erased: purgeAfter is what gives it the thirty-day window.
    expect(retire.data.purgeAfter).toBeInstanceOf(Date);
    expect(retire.data.deletedAt).toBeInstanceOf(Date);
  });

  it("locks the member's photo rows before reading them", async () => {
    // Without the lock two concurrent replacements each see no predecessor, each activate, and the
    // second fails on the unique index instead of replacing.
    await claimStagedUserPhoto("att-1", { enabled });

    expect(mocks.queryRaw).toHaveBeenCalled();
  });

  it("refuses when the acting membership is not a live member of the household", async () => {
    // A disabled or removed membership must not gain a new picture.
    mocks.memberFindFirst.mockResolvedValue(null);

    await expect(claimStagedUserPhoto("att-1", { enabled })).rejects.toThrow("not_found");
    expect(mocks.attachmentUpdateMany).not.toHaveBeenCalled();
  });

  it("asks the database to exclude disabled and removed memberships, rather than trusting the session", async () => {
    // Asserting the refusal alone is not enough: a mock that returns null no matter what is asked
    // still refuses, so dropping disabledAt/deletedAt from the query would go unnoticed. Pin the
    // filter itself, because that is the thing standing between a suspended account and a write.
    await claimStagedUserPhoto("att-1", { enabled });

    expect(mocks.memberFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "member-1", householdId: "household-1", disabledAt: null, deletedAt: null }
    }));
  });

  it("refuses to claim an upload staged by somebody else", async () => {
    // createdByMemberId in the where clause is what stops one member claiming another's staged
    // bytes; if no row matches, nothing is activated.
    mocks.attachmentUpdateMany.mockResolvedValue({ count: 0 });

    await expect(claimStagedUserPhoto("att-1", { enabled })).rejects.toThrow("not_found");
  });

  it("locks the session the request arrived on", async () => {
    // lockPhotoWriteActor pins the actor's session row, so the browser-operation context is
    // required; a plain household context has no sessionId and the lock would be meaningless.
    await claimStagedUserPhoto("att-1", { enabled });

    expect(mocks.lockPhotoWriteActor).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: "session-1" }));
  });

  it("records the activation against the member", async () => {
    await claimStagedUserPhoto("att-1", { enabled });

    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "attachment.activate", entityType: "member", entityId: "member-1" }),
      expect.anything()
    );
  });
});
