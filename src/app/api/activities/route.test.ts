import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createActivity: vi.fn(), listActivities: vi.fn() }));
vi.mock("@/server/services/activities", () => mocks);

import { POST } from "@/app/api/activities/route";

const body = {
  clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64007",
  babyId: "baby-1",
  type: "feeding",
  occurredAt: "2026-07-30T12:00:00.000Z",
  mode: "bottle"
};

function request(payload = body) {
  return new Request("http://localhost/api/activities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

describe("POST /api/activities", () => {
  beforeEach(() => vi.resetAllMocks());

  it("forwards the client mutation ID and returns the authoritative activity", async () => {
    mocks.createActivity.mockResolvedValue({ id: "activity-1", clientMutationId: body.clientMutationId });

    const response = await POST(request());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { id: "activity-1" } });
    expect(mocks.createActivity).toHaveBeenCalledWith(body);
  });

  it("maps a same-key different-payload conflict without exposing internals", async () => {
    mocks.createActivity.mockRejectedValue(new Error("idempotency_conflict"));

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
  });
});
