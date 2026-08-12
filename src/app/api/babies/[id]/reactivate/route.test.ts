import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issueReactivateBabyBrowserOperation: vi.fn(),
  submitReactivateBabyBrowserOperation: vi.fn(),
  browserOperationFailureResult: vi.fn()
}));
vi.mock("@/server/services/households", () => ({
  issueReactivateBabyBrowserOperation: mocks.issueReactivateBabyBrowserOperation,
  submitReactivateBabyBrowserOperation: mocks.submitReactivateBabyBrowserOperation
}));
vi.mock("@/server/services/browser-operations", () => ({
  browserOperationFailureResult: mocks.browserOperationFailureResult
}));

import { POST } from "./route";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";

beforeEach(() => vi.resetAllMocks());

describe("POST /api/babies/[id]/reactivate", () => {
  it("issues and submits one baby-bound browser operation", async () => {
    mocks.issueReactivateBabyBrowserOperation.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
    mocks.submitReactivateBabyBrowserOperation.mockResolvedValue({ status: "completed", operationId, outcome: { kind: "baby_lifecycle", code: "ok", babyId: "baby-1", inactive: false } });

    const response = await POST(new Request("http://localhost/api/babies/baby-1/reactivate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId })
    }), { params: { id: "baby-1" } });

    expect(await response.json()).toEqual({ ok: true, data: { status: "completed", operationId } });
    expect(mocks.issueReactivateBabyBrowserOperation).toHaveBeenCalledWith({ operationId, babyId: "baby-1" });
    expect(mocks.submitReactivateBabyBrowserOperation).toHaveBeenCalledWith({ operationId, babyId: "baby-1" });
  });
});
