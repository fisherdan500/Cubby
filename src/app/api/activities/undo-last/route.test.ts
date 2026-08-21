import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  undoLastActivity: vi.fn(),
  issueActivityUndoLastBrowserOperation: vi.fn(),
  submitActivityUndoLastBrowserOperation: vi.fn()
}));
vi.mock("@/server/services/activities", () => mocks);

import { POST } from "@/app/api/activities/undo-last/route";

describe("POST /api/activities/undo-last", () => {
  beforeEach(() => vi.resetAllMocks());

  it("issues a prepared reservation without executing legacy undo", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    mocks.issueActivityUndoLastBrowserOperation.mockResolvedValue({ status: "prepared", operationId, code: "operation_prepared" });
    const response = await POST(new Request("http://localhost/api/activities/undo-last?issue=1", { method: "POST", body: "{}" }));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { status: "prepared", operationId } });
    expect(mocks.submitActivityUndoLastBrowserOperation).not.toHaveBeenCalled();
    expect(mocks.undoLastActivity).not.toHaveBeenCalled();
  });

  it("submits the same retained ID when re-issue returns prepared", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const body = { operationId };
    mocks.issueActivityUndoLastBrowserOperation.mockResolvedValue({ status: "prepared", operationId, code: "operation_prepared" });
    mocks.submitActivityUndoLastBrowserOperation.mockResolvedValue({ status: "completed", operationId, outcome: { kind: "activity", code: "ok", activityId: "activity-1", action: "undo" } });
    const response = await POST(new Request("http://localhost/api/activities/undo-last", { method: "POST", body: JSON.stringify(body) }));
    expect(response.status).toBe(200);
    expect(mocks.submitActivityUndoLastBrowserOperation).toHaveBeenCalledWith(body);
    expect(mocks.undoLastActivity).not.toHaveBeenCalled();
  });

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
