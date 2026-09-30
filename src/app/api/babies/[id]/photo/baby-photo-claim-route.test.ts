/**
 * Claiming a staged picture as a baby's profile picture.
 *
 * The service layer already enforces ownership in the database. What only the route can get wrong
 * is which baby id it trusts: taking it from the request body would let a caller aim a claim at
 * another household's baby, so the id comes from the path and the household from the session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimStagedBabyPhoto: vi.fn(),
  getEffectiveHouseholdContext: vi.fn(),
  requirePermission: vi.fn()
}));

vi.mock("@/server/services/attachments", () => ({
  claimStagedBabyPhoto: mocks.claimStagedBabyPhoto
}));

vi.mock("@/server/auth/context", () => ({
  getEffectiveHouseholdContext: mocks.getEffectiveHouseholdContext,
  requirePermission: mocks.requirePermission
}));

const { PUT } = await import("./route");

function request(body: unknown) {
  return new Request("http://localhost/api/babies/baby-1/photo", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" }
  });
}

const params = { params: { id: "baby-1" } };

describe("claiming a baby's profile picture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEffectiveHouseholdContext.mockResolvedValue({ householdId: "household-1", memberId: "member-1" });
    mocks.requirePermission.mockReturnValue(undefined);
    mocks.claimStagedBabyPhoto.mockResolvedValue({ attachmentId: "att-1", babyId: "baby-1" });
  });

  it("claims the staged picture for the baby named in the path", async () => {
    const response = await PUT(request({ attachmentId: "att-1" }), params);

    expect(response.status).toBe(200);
    expect(mocks.claimStagedBabyPhoto).toHaveBeenCalledWith("att-1", "baby-1");
  });

  it("takes the baby from the path and ignores any babyId in the body", async () => {
    // The attack this blocks: a caller who can edit their own household's baby posts a body naming
    // a different household's baby. The body must not be able to redirect the claim.
    await PUT(request({ attachmentId: "att-1", babyId: "someone-elses-baby" }), params);

    expect(mocks.claimStagedBabyPhoto).toHaveBeenCalledWith("att-1", "baby-1");
  });

  it("demands baby.manage", async () => {
    await PUT(request({ attachmentId: "att-1" }), params);

    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ householdId: "household-1" }),
      "baby.manage"
    );
  });

  it("refuses without calling the service when the caller lacks permission", async () => {
    mocks.requirePermission.mockImplementation(() => { throw new Error("forbidden"); });

    const response = await PUT(request({ attachmentId: "att-1" }), params);

    expect(response.status).toBe(403);
    expect(mocks.claimStagedBabyPhoto).not.toHaveBeenCalled();
  });

  it("rejects a body with no attachment id instead of passing undefined down", async () => {
    const response = await PUT(request({}), params);

    expect(response.status).toBe(400);
    expect(mocks.claimStagedBabyPhoto).not.toHaveBeenCalled();
  });

  it("reports a missing or already-claimed upload as not found", async () => {
    mocks.claimStagedBabyPhoto.mockRejectedValue(new Error("not_found"));

    const response = await PUT(request({ attachmentId: "att-gone" }), params);

    expect(response.status).toBe(404);
  });
});
