import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deleteActivity: vi.fn(), updateActivity: vi.fn() }));
vi.mock("@/server/services/activities", () => mocks);

import { DELETE } from "@/app/api/activities/[id]/route";

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
