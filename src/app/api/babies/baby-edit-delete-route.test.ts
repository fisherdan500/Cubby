import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

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

function request(body: unknown, method = "PATCH") {
  return new Request("http://localhost/api/babies/baby-1", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function deleteRequest(body: unknown) {
  return request(body, "DELETE");
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
    await DELETE(deleteRequest({ confirmation: "Yes Delete Baby Sprout" }), { params: { id: "baby-1" } });

    expect(mocks.deleteBaby).toHaveBeenCalledWith("baby-1", { confirmation: "Yes Delete Baby Sprout" });
    expect(mocks.removeBabyProfile).not.toHaveBeenCalled();
  });

  it("removes the profile only when that mode is asked for explicitly", async () => {
    await DELETE(
      deleteRequest({ confirmation: "Yes Delete Baby Sprout", mode: "remove" }),
      { params: { id: "baby-1" } }
    );

    expect(mocks.removeBabyProfile).toHaveBeenCalledWith("baby-1", { confirmation: "Yes Delete Baby Sprout" });
    expect(mocks.deleteBaby).not.toHaveBeenCalled();
  });

  it("forwards only the confirmation, so a caller cannot smuggle its own name past the check", async () => {
    await DELETE(
      deleteRequest({ confirmation: "Yes Delete Baby Sprout", mode: "remove", name: "Sprout" }),
      { params: { id: "baby-1" } }
    );

    expect(mocks.removeBabyProfile).toHaveBeenCalledWith("baby-1", { confirmation: "Yes Delete Baby Sprout" });
  });

  it("reports a refused confirmation rather than succeeding quietly", async () => {
    mocks.deleteBaby.mockRejectedValue(new Error("confirmation_mismatch"));

    const response = await DELETE(deleteRequest({ confirmation: "wrong" }), { params: { id: "baby-1" } });

    // Exact status and code: a range check is satisfied by the 500 that means the code is unmapped.
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("confirmation_mismatch");
  });

  it("reports a refused removal when the baby has history", async () => {
    mocks.removeBabyProfile.mockRejectedValue(new Error("baby_has_history"));

    const response = await DELETE(
      deleteRequest({ confirmation: "Yes Delete Baby Sprout", mode: "remove" }),
      { params: { id: "baby-1" } }
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("baby_has_history");
  });

  it("reports an unusable birth date as a bad value, not a server fault", async () => {
    mocks.updateBaby.mockRejectedValue(new Error("baby_birth_date_invalid"));

    const response = await PATCH(request({ birthDate: "not-a-date" }), { params: { id: "baby-1" } });
    const body = await response.json() as { ok: false; error: { code: string } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("baby_birth_date_invalid");
  });

  it("maps a schema rejection to a bad-value answer rather than a server fault", async () => {
    // The route does no validation of its own: it hands the raw body to updateBaby, whose
    // babyUpdateSchema is .strict(). So the schema is the gate, and what matters here is that its
    // rejection is reported as 422 rather than surfacing as a 500. That the schema actually
    // refuses a smuggled field is pinned separately in src/lib/validation/baby-update.test.ts.
    mocks.updateBaby.mockRejectedValue(
      new ZodError([{ code: "unrecognized_keys", keys: ["householdId"], path: [], message: "Unrecognized key" }] as never)
    );

    const response = await PATCH(
      request({ name: "Rosie", householdId: "household-2" }),
      { params: { id: "baby-1" } }
    );
    const body = await response.json() as { ok: false; error: { code: string } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_error");
  });

  it("hands the whole body to the writer, so the writer's schema is the only gate", async () => {
    // Documents the contract deliberately: the route forwards unknown keys rather than silently
    // stripping them, because stripping would let a smuggled field pass unnoticed.
    await PATCH(request({ name: "Rosie", householdId: "household-2" }), { params: { id: "baby-1" } });

    expect(mocks.updateBaby).toHaveBeenCalledWith("baby-1", {
      name: "Rosie",
      householdId: "household-2"
    });
  });
});
