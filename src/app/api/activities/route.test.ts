import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createActivity: vi.fn(),
  listActivities: vi.fn(),
  issueActivityCreateBrowserOperation: vi.fn(),
  submitActivityCreateBrowserOperation: vi.fn()
}));
vi.mock("@/server/services/activities", () => mocks);

import { POST } from "@/app/api/activities/route";

const body = {
  clientMutationId: "018f2b6c-8f5f-7e0b-8c3f-9f42c0a64007",
  babyId: "baby-1",
  type: "feeding",
  occurredAt: "2026-07-30T12:00:00.000Z",
  mode: "bottle"
};

function request(payload: Record<string, unknown> = body) {
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

  it("returns a durable terminal create replay through the browser-operation issue path", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const completed = {
      status: "completed",
      operationId,
      outcome: { kind: "activity", code: "ok", activityId: "activity-1", action: "create" }
    };
    mocks.issueActivityCreateBrowserOperation.mockResolvedValue(completed);

    const response = await POST(request({ ...body, operationId }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: completed });
    expect(mocks.issueActivityCreateBrowserOperation).toHaveBeenCalledWith({ ...body, operationId });
    expect(mocks.submitActivityCreateBrowserOperation).not.toHaveBeenCalled();
  });
});
