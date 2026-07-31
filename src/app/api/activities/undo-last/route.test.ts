import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ undoLastActivity: vi.fn() }));
vi.mock("@/server/services/activities", () => mocks);

import { POST } from "@/app/api/activities/undo-last/route";

describe("POST /api/activities/undo-last", () => {
  beforeEach(() => vi.resetAllMocks());

  it("forwards a supplied mutation ID", async () => {
    mocks.undoLastActivity.mockResolvedValue({ id: "activity-1" });
    const body = { clientMutationId: "44444444-4444-4444-8444-444444444444" };

    const response = await POST(new Request("http://localhost/api/activities/undo-last", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }));

    expect(response.status).toBe(200);
    expect(mocks.undoLastActivity).toHaveBeenCalledWith(body);
  });

  it("preserves body-less legacy compatibility", async () => {
    mocks.undoLastActivity.mockResolvedValue({ id: "activity-1" });

    await POST(new Request("http://localhost/api/activities/undo-last", { method: "POST" }));

    expect(mocks.undoLastActivity).toHaveBeenCalledWith(undefined);
  });

  it("rejects malformed non-empty JSON without invoking undo", async () => {
    const response = await POST(new Request("http://localhost/api/activities/undo-last", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    }));

    expect(response.status).toBe(422);
    expect(mocks.undoLastActivity).not.toHaveBeenCalled();
  });

  it("rejects a non-empty whitespace body without invoking undo", async () => {
    const response = await POST(new Request("http://localhost/api/activities/undo-last", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: " \t "
    }));

    expect(response.status).toBe(422);
    expect(mocks.undoLastActivity).not.toHaveBeenCalled();
  });

  it("maps an invalid mutation UUID to stable validation", async () => {
    mocks.undoLastActivity.mockRejectedValue(new Error("validation_error"));

    const response = await POST(new Request("http://localhost/api/activities/undo-last", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientMutationId: "not-a-uuid" })
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "validation_error" } });
  });

  it("maps receipt binding conflicts without exposing internals", async () => {
    mocks.undoLastActivity.mockRejectedValue(new Error("idempotency_conflict"));

    const response = await POST(new Request("http://localhost/api/activities/undo-last", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientMutationId: "44444444-4444-4444-8444-444444444444" })
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "idempotency_conflict" } });
  });
});
