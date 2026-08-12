import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issueDeactivateBabyBrowserOperation: vi.fn(),
  submitDeactivateBabyBrowserOperation: vi.fn(),
  browserOperationFailureResult: vi.fn()
}));
vi.mock("@/server/services/households", () => ({
  issueDeactivateBabyBrowserOperation: mocks.issueDeactivateBabyBrowserOperation,
  submitDeactivateBabyBrowserOperation: mocks.submitDeactivateBabyBrowserOperation
}));
vi.mock("@/server/services/browser-operations", () => ({
  browserOperationFailureResult: mocks.browserOperationFailureResult
}));

import { POST } from "./route";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";

beforeEach(() => vi.resetAllMocks());

describe("POST /api/babies/[id]/deactivate", () => {
  it("issues and submits one baby-bound browser operation", async () => {
    mocks.issueDeactivateBabyBrowserOperation.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
    mocks.submitDeactivateBabyBrowserOperation.mockResolvedValue({ status: "completed", operationId, outcome: { kind: "baby_lifecycle", code: "ok", babyId: "baby-1", inactive: true } });

    const response = await POST(new Request("http://localhost/api/babies/baby-1/deactivate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId })
    }), { params: { id: "baby-1" } });

    expect(await response.json()).toEqual({ ok: true, data: { status: "completed", operationId } });
    expect(mocks.issueDeactivateBabyBrowserOperation).toHaveBeenCalledWith({ operationId, babyId: "baby-1" });
    expect(mocks.submitDeactivateBabyBrowserOperation).toHaveBeenCalledWith({ operationId, babyId: "baby-1" });
  });

  it("returns only a non-disclosing stale outcome", async () => {
    mocks.issueDeactivateBabyBrowserOperation.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
    mocks.submitDeactivateBabyBrowserOperation.mockResolvedValue({ status: "stale", operationId, code: "stale_target" });

    const response = await POST(new Request("http://localhost/api/babies/baby-1/deactivate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId })
    }), { params: { id: "baby-1" } });

    expect(await response.json()).toEqual({ ok: true, data: { status: "stale", operationId } });
  });
});
