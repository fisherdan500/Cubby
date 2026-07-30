import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ leaveHousehold: vi.fn() }));
vi.mock("@/server/services/household-leave", () => ({ leaveHousehold: mocks.leaveHousehold }));

import { POST } from "@/app/api/households/leave/route";

const body = {
  householdId: "household-1",
  confirmation: "River House",
  operationId: "11111111-1111-4111-8111-111111111111"
};

describe("POST /api/households/leave", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.leaveHousehold.mockResolvedValue({
      operationId: body.operationId,
      householdId: body.householdId,
      membershipId: "member-1",
      leftAt: new Date("2026-07-29T23:30:00.000Z"),
      reason: "self_left"
    });
  });

  it("passes the explicit confirmation and operation identity to the service", async () => {
    const response = await POST(new Request("http://localhost/api/households/leave", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { operationId: body.operationId, reason: "self_left" }
    });
    expect(mocks.leaveHousehold).toHaveBeenCalledWith(body);
  });

  it("fails closed for invalid JSON", async () => {
    const response = await POST(new Request("http://localhost/api/households/leave", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    }));

    expect(response.status).toBe(400);
    expect(mocks.leaveHousehold).not.toHaveBeenCalled();
  });

  it.each([
    ["household_owner_cannot_leave", 409],
    ["household_leave_confirmation_mismatch", 422],
    ["fresh_authentication_required", 403]
  ])("maps %s without exposing internals", async (code, status) => {
    mocks.leaveHousehold.mockRejectedValue(new Error(code));

    const response = await POST(new Request("http://localhost/api/households/leave", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code } });
  });
});
