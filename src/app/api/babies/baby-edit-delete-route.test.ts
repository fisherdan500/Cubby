import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateBaby: vi.fn(),
  deleteBaby: vi.fn(),
  removeBabyProfile: vi.fn()
}));

vi.mock("@/server/services/households", () => ({
  updateBaby: mocks.updateBaby,
  deleteBaby: mocks.deleteBaby,
  removeBabyProfile: mocks.removeBabyProfile
}));

import { DELETE, PATCH } from "@/app/api/babies/[id]/route";

function request(body: unknown) {
  return new Request("http://localhost/api/babies/baby-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("baby edit and delete route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.updateBaby.mockResolvedValue({ id: "baby-1", name: "Rosie" });
    mocks.deleteBaby.mockResolvedValue({ id: "baby-1" });
    mocks.removeBabyProfile.mockResolvedValue({ id: "baby-1" });
  });

  it("passes the edit through to the service", async () => {
    const response = await PATCH(request({ name: "Rosie" }), { params: { id: "baby-1" } });

    expect(response.status).toBe(200);
    expect(mocks.updateBaby).toHaveBeenCalledWith("baby-1", { name: "Rosie" });
  });

  it("hides the baby by default rather than removing it", async () => {
    await DELETE(request({ confirmation: "Yes Delete Baby Sprout" }), { params: { id: "baby-1" } });

    expect(mocks.deleteBaby).toHaveBeenCalledWith("baby-1", { confirmation: "Yes Delete Baby Sprout" });
    expect(mocks.removeBabyProfile).not.toHaveBeenCalled();
  });

  it("removes the profile only when that mode is asked for explicitly", async () => {
    await DELETE(
      request({ confirmation: "Yes Delete Baby Sprout", mode: "remove" }),
      { params: { id: "baby-1" } }
    );

    expect(mocks.removeBabyProfile).toHaveBeenCalledWith("baby-1", { confirmation: "Yes Delete Baby Sprout" });
    expect(mocks.deleteBaby).not.toHaveBeenCalled();
  });

  it("forwards only the confirmation, so a caller cannot smuggle its own name past the check", async () => {
    await DELETE(
      request({ confirmation: "Yes Delete Baby Sprout", mode: "remove", name: "Sprout" }),
      { params: { id: "baby-1" } }
    );

    expect(mocks.removeBabyProfile).toHaveBeenCalledWith("baby-1", { confirmation: "Yes Delete Baby Sprout" });
  });

  it("reports a refused confirmation rather than succeeding quietly", async () => {
    mocks.deleteBaby.mockRejectedValue(new Error("confirmation_mismatch"));

    const response = await DELETE(request({ confirmation: "wrong" }), { params: { id: "baby-1" } });

    // Exact status and code: a range check is satisfied by the 500 that means the code is unmapped.
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("confirmation_mismatch");
  });

  it("reports a refused removal when the baby has history", async () => {
    mocks.removeBabyProfile.mockRejectedValue(new Error("baby_has_history"));

    const response = await DELETE(
      request({ confirmation: "Yes Delete Baby Sprout", mode: "remove" }),
      { params: { id: "baby-1" } }
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("baby_has_history");
  });
});
