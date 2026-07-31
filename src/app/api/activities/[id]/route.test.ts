import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deleteActivity: vi.fn(), updateActivity: vi.fn() }));
vi.mock("@/server/services/activities", () => mocks);

import { DELETE, PATCH } from "@/app/api/activities/[id]/route";

describe("PATCH /api/activities/[id]", () => {
  beforeEach(() => vi.resetAllMocks());

  it("forwards the update payload and stable mutation ID", async () => {
    mocks.updateActivity.mockResolvedValue({ id: "activity-1" });
    const body = {
      babyId: "baby-1",
      occurredAt: "2026-07-14T12:00:00.000Z",
      type: "feeding",
      mode: "bottle",
      clientMutationId: "11111111-1111-4111-8111-111111111111",
      expectedUpdatedAt: "2026-07-14T10:00:00.000Z"
    };

    const response = await PATCH(new Request("http://localhost/api/activities/activity-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }), { params: { id: "activity-1" } });

    expect(response.status).toBe(200);
    expect(mocks.updateActivity).toHaveBeenCalledWith("activity-1", body);
  });
  it("rejects malformed PATCH JSON without invoking update", async () => {
    const response = await PATCH(new Request("http://localhost/api/activities/activity-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{"
    }), { params: { id: "activity-1" } });

    expect(response.status).toBe(422);
    expect(mocks.updateActivity).not.toHaveBeenCalled();
  });

  it("rejects exactly-empty PATCH bodies without invoking update", async () => {
    const response = await PATCH(new Request("http://localhost/api/activities/activity-1", { method: "PATCH" }), {
      params: { id: "activity-1" }
    });

    expect(response.status).toBe(422);
    expect(mocks.updateActivity).not.toHaveBeenCalled();
  });

  it("maps stale update conflicts to the stable revision response", async () => {
    mocks.updateActivity.mockRejectedValue(new Error("stale_revision"));
    const response = await PATCH(new Request("http://localhost/api/activities/activity-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ babyId: "baby-1", occurredAt: "2026-07-14T12:00:00.000Z", type: "feeding", mode: "bottle", clientMutationId: "11111111-1111-4111-8111-111111111111", expectedUpdatedAt: "2026-07-14T10:00:00.000Z" })
    }), { params: { id: "activity-1" } });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "stale_revision" } });
  });

  it.each([
    { babyId: "baby-1", occurredAt: "2026-07-14T12:00:00.000Z", type: "feeding", mode: "bottle", expectedUpdatedAt: "2026-07-14T10:00:00.000Z" },
    { babyId: "baby-1", occurredAt: "2026-07-14T12:00:00.000Z", type: "feeding", mode: "bottle", clientMutationId: "11111111-1111-4111-8111-111111111111" }
  ])("rejects legacy PATCH bodies missing the required retry contract", async (body) => {
    const response = await PATCH(new Request("http://localhost/api/activities/activity-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }), { params: { id: "activity-1" } });

    expect(response.status).toBe(422);
    expect(mocks.updateActivity).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/activities/[id]", () => {
  beforeEach(() => vi.resetAllMocks());

  it("forwards a supplied mutation ID", async () => {
    mocks.deleteActivity.mockResolvedValue({ id: "activity-1" });
    const body = { clientMutationId: "55555555-5555-4555-8555-555555555555" };

    const response = await DELETE(new Request("http://localhost/api/activities/activity-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }), { params: { id: "activity-1" } });

    expect(response.status).toBe(200);
    expect(mocks.deleteActivity).toHaveBeenCalledWith("activity-1", body);
  });

  it("preserves exactly-empty legacy bodies", async () => {
    mocks.deleteActivity.mockResolvedValue({ id: "activity-1" });

    await DELETE(new Request("http://localhost/api/activities/activity-1", { method: "DELETE" }), {
      params: { id: "activity-1" }
    });

    expect(mocks.deleteActivity).toHaveBeenCalledWith("activity-1", undefined);
  });

  it("rejects malformed non-empty JSON without invoking delete", async () => {
    const response = await DELETE(new Request("http://localhost/api/activities/activity-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{"
    }), { params: { id: "activity-1" } });

    expect(response.status).toBe(422);
    expect(mocks.deleteActivity).not.toHaveBeenCalled();
  });

  it("maps invalid mutation UUIDs to stable validation", async () => {
    mocks.deleteActivity.mockRejectedValue(new Error("validation_error"));

    const response = await DELETE(new Request("http://localhost/api/activities/activity-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientMutationId: "not-a-uuid" })
    }), { params: { id: "activity-1" } });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "validation_error" } });
  });
});
