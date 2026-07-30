import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createOnboardingHousehold: vi.fn() }));
vi.mock("@/server/services/households", () => ({
  createOnboardingHousehold: mocks.createOnboardingHousehold
}));

import { POST } from "@/app/api/onboarding/route";

const body = { householdName: "River House", babyName: "Avery" };

describe("POST /api/onboarding", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createOnboardingHousehold.mockResolvedValue({ id: "household-1" });
  });

  it("does not let a suspended membership bypass the leave flow through the direct endpoint", async () => {
    mocks.createOnboardingHousehold.mockRejectedValue(new Error("suspended_membership_must_leave"));

    const response = await POST(new Request("http://localhost/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "suspended_membership_must_leave" }
    });
  });
});
