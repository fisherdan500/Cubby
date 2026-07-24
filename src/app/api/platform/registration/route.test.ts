import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn()
}));

vi.mock("@/server/services/platform-authority", () => ({
  getPlatformRegistrationSettings: mocks.getSettings,
  updatePlatformRegistrationSettings: mocks.updateSettings
}));

import { GET, PUT } from "@/app/api/platform/registration/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSettings.mockResolvedValue({
    householdCreationMode: "closed",
    allowPublicRegistration: false
  });
  mocks.updateSettings.mockResolvedValue({
    householdCreationMode: "open",
    allowPublicRegistration: true
  });
});

describe("platform registration API", () => {
  it("reads settings only through the platform-owner service boundary", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { householdCreationMode: "closed", allowPublicRegistration: false }
    });
  });

  it("updates the complete bounded policy object", async () => {
    const response = await PUT(
      new Request("http://localhost/api/platform/registration", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdCreationMode: "open",
          allowPublicRegistration: true
        })
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      householdCreationMode: "open",
      allowPublicRegistration: true
    });
  });

  it.each([
    ["unauthenticated", 401],
    ["forbidden", 403],
    ["platform_uninitialized", 409]
  ])("maps %s to a fail-closed response", async (message, status) => {
    mocks.getSettings.mockRejectedValue(new Error(message));

    const response = await GET();

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: message } });
  });
});
