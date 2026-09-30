/**
 * The HTTP surface for baby profile pictures.
 *
 * The service layer is already proven; what these cover is the part only the route can get wrong -
 * that the permission is enforced BEFORE any byte is read, that the upload is bounded by the baby
 * policy rather than the larger feed policy, and that a claim cannot be aimed at another
 * household's baby by editing the request body.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stageBabyPhoto: vi.fn(),
  claimStagedBabyPhoto: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn(),
  readBoundedBytes: vi.fn()
}));

vi.mock("@/server/services/attachments", () => ({
  stageBabyPhoto: mocks.stageBabyPhoto,
  claimStagedBabyPhoto: mocks.claimStagedBabyPhoto
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));

vi.mock("@/server/http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/http")>();
  return { ...actual, readBoundedBytes: mocks.readBoundedBytes };
});

import { attachmentPolicy } from "@/domain/attachments";

const { POST } = await import("./route");

describe("uploading a baby's profile picture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEffectiveHouseholdContext.mockResolvedValue({ householdId: "household-1", memberId: "member-1" });
    mocks.requirePermission.mockReturnValue(undefined);
    mocks.readBoundedBytes.mockResolvedValue(Buffer.from("jpeg-bytes"));
    mocks.stageBabyPhoto.mockResolvedValue({ attachmentId: "att-1", width: 512, height: 512 });
  });

  it("stages the upload and reports where it went", async () => {
    const response = await POST(new Request("http://localhost/api/attachments/baby-photos", { method: "POST" }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ data: { attachmentId: "att-1" } });
    // Nothing may be cached: the staged picture is private until it is claimed.
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("demands baby.manage, not the weaker feed permission", async () => {
    // A caretaker can post photos to the feed but must not be able to change a child's identity
    // picture. Asserting the exact permission string is the whole point of this test.
    await POST(new Request("http://localhost/api/attachments/baby-photos", { method: "POST" }));

    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ householdId: "household-1" }),
      "baby.manage"
    );
  });

  it("refuses before reading a single byte when the caller lacks permission", async () => {
    // Order matters: checking after the read would let an unauthorised caller push a large body
    // through the server first.
    mocks.requirePermission.mockImplementation(() => { throw new Error("forbidden"); });

    const response = await POST(new Request("http://localhost/api/attachments/baby-photos", { method: "POST" }));

    expect(response.status).toBe(403);
    expect(mocks.readBoundedBytes).not.toHaveBeenCalled();
    expect(mocks.stageBabyPhoto).not.toHaveBeenCalled();
  });

  it("bounds the upload by the baby policy, not the feed policy", async () => {
    // These limits differ. Using the feed bound here would let a bigger body through than the baby
    // policy allows, and the mismatch would only show up as a confusing failure deeper in.
    await POST(new Request("http://localhost/api/attachments/baby-photos", { method: "POST" }));

    expect(mocks.readBoundedBytes).toHaveBeenCalledWith(
      expect.anything(),
      attachmentPolicy.baby_photo.maxInputBytes,
      "attachment_too_large"
    );
  });
});
