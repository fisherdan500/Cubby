import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeHouseholdSelection: vi.fn(),
  clearHouseholdSelection: vi.fn()
}));

vi.mock("@/server/services/household-selection", () => ({
  authorizeHouseholdSelection: mocks.authorizeHouseholdSelection,
  clearHouseholdSelection: mocks.clearHouseholdSelection
}));

import { POST } from "@/app/api/household-selection/route";
import { SELECTED_HOUSEHOLD_MEMBER_COOKIE } from "@/server/auth/context";

function formRequest(body: Record<string, string>, origin = "http://localhost") {
  return new Request("http://localhost/api/household-selection", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(body)
  });
}

describe("POST /api/household-selection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authorizeHouseholdSelection.mockResolvedValue({ memberId: "member-2" });
    mocks.clearHouseholdSelection.mockResolvedValue(undefined);
  });

  it("authorizes the exact current membership episode before setting an HttpOnly SameSite same-origin candidate", async () => {
    const response = await POST(formRequest({ memberId: "member-2", returnTo: "/app/reports" }));

    expect(mocks.authorizeHouseholdSelection).toHaveBeenCalledWith("member-2");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/app/reports");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SELECTED_HOUSEHOLD_MEMBER_COOKIE}=member-2`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Domain=");
  });

  it("is existence-neutral and sets no candidate for a suspended, removed, or foreign episode", async () => {
    mocks.authorizeHouseholdSelection.mockRejectedValue(new Error("not_found"));

    const response = await POST(formRequest({ memberId: "foreign-member" }));

    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("rejects cross-origin selection submissions before authorization", async () => {
    const response = await POST(formRequest({ memberId: "member-2" }, "http://evil.example"));

    expect(response.status).toBe(403);
    expect(mocks.authorizeHouseholdSelection).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("clears only the candidate after validating the current session", async () => {
    const response = await POST(formRequest({ intent: "clear" }));

    expect(mocks.clearHouseholdSelection).toHaveBeenCalledTimes(1);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SELECTED_HOUSEHOLD_MEMBER_COOKIE}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
  });
});
