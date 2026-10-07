import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createOnboardingHousehold: vi.fn() }));
vi.mock("@/server/services/households", () => ({
  createOnboardingHousehold: mocks.createOnboardingHousehold
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  trustedOrigins: () => ["https://cubby.example"]
}));

import { POST } from "@/app/api/onboarding/route";
import { SELECTED_HOUSEHOLD_MEMBER_COOKIE } from "@/server/auth/context";

const body = { householdName: "River House", babyName: "Avery" };
const household = {
  id: "household-1",
  name: "River House",
  createdByUserId: "owner-1",
  settings: { allowPublicRegistration: false, allowNewHouseholdCreation: false }
};

describe("POST /api/onboarding", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createOnboardingHousehold.mockResolvedValue({ household, memberId: "member-1" });
  });

  it("rejects an unknown mode without falling through to ordinary creation", async () => {
    const response = await POST(new Request("http://localhost/api/onboarding", {
      method: "POST", body: JSON.stringify({ ...body, mode: "unknown" })
    }));
    expect(response.status).toBe(422);
    expect(mocks.createOnboardingHousehold).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "restore", householdName: "Recovery" },
    body
  ])("passes the supported request to the creation boundary: %j", async (input) => {
    const response = await POST(new Request("http://localhost/api/onboarding", { method: "POST", body: JSON.stringify(input) }));
    expect(response.status).toBe(200);
    expect(mocks.createOnboardingHousehold).toHaveBeenCalledWith(input);
    expect(response.headers.get("set-cookie")).toContain(`${SELECTED_HOUSEHOLD_MEMBER_COOKIE}=member-1`);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
    expect(response.headers.get("set-cookie")).toContain("Path=/");
    await expect(response.json()).resolves.toEqual({ ok: true, data: household });
  });

  it("marks the new membership cookie Secure on an HTTPS onboarding request", async () => {
    const response = await POST(new Request("https://cubby.example/api/onboarding", {
      method: "POST",
      body: JSON.stringify({ mode: "restore", householdName: "Recovery" })
    }));

    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("uses the trusted public HTTPS Origin for the cookie behind an internal HTTP listener", async () => {
    const response = await POST(new Request("http://0.0.0.0:3000/api/onboarding", {
      method: "POST",
      headers: { origin: "https://cubby.example" },
      body: JSON.stringify({ mode: "restore", householdName: "Recovery" })
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("rejects an untrusted Origin before creating a household", async () => {
    const response = await POST(new Request("http://0.0.0.0:3000/api/onboarding", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify(body)
    }));

    expect(response.status).toBe(403);
    expect(mocks.createOnboardingHousehold).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    { mode: "restore", householdName: "Recovery", babyName: "Unexpected" },
    { mode: "restore", householdName: "Recovery", extra: true },
    { mode: "restore", householdName: " " },
    { mode: "restore", householdName: "a".repeat(81) },
    { mode: null, ...body }
  ])("refuses a non-closed restore shape: %j", async (input) => {
    const response = await POST(new Request("http://localhost/api/onboarding", { method: "POST", body: JSON.stringify(input) }));
    expect(response.status).toBe(422);
    expect(mocks.createOnboardingHousehold).not.toHaveBeenCalled();
  });

  it.each(["unauthenticated", "email_not_verified", "forbidden", "suspended_membership_must_leave"])("preserves restore refusal: %s", async (code) => {
    mocks.createOnboardingHousehold.mockRejectedValue(new Error(code));
    const response = await POST(new Request("http://localhost/api/onboarding", {
      method: "POST", body: JSON.stringify({ mode: "restore", householdName: "Recovery" })
    }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code } });
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
