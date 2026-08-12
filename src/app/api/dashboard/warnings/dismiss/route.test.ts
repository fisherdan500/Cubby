import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issueDashboardWarningBrowserOperation: vi.fn(),
  dismissDashboardWarningBrowserOperation: vi.fn(),
  browserOperationFailureResult: vi.fn((operationId: unknown, error: unknown) =>
    error instanceof Error && error.message === "idempotency_conflict"
      ? { status: "rejected", operationId, code: "idempotency_conflict" }
      : null
  )
}));
vi.mock("@/server/services/dashboard", () => ({
  issueDashboardWarningBrowserOperation: mocks.issueDashboardWarningBrowserOperation,
  dismissDashboardWarningBrowserOperation: mocks.dismissDashboardWarningBrowserOperation
}));
vi.mock("@/server/services/browser-operations", () => ({
  browserOperationFailureResult: mocks.browserOperationFailureResult
}));

import { POST } from "./route";

const body = {
  operationId: "bmo_0123456789abcdefghjkmnpqrs",
  babyId: "baby-1",
  type: "feeding",
  fingerprint: "baby-1:feeding:never"
};

beforeEach(() => vi.resetAllMocks());

describe("POST /api/dashboard/warnings/dismiss", () => {
  it("uses one browser operation through issuance and terminal execution", async () => {
    mocks.issueDashboardWarningBrowserOperation.mockResolvedValue({ status: "pending", operationId: body.operationId });
    mocks.dismissDashboardWarningBrowserOperation.mockResolvedValue({ status: "completed", operationId: body.operationId, outcome: { kind: "warning_dismissed", code: "ok", warningKey: "feeding:baby-1:feeding:never" } });

    const response = await POST(new Request("http://localhost/api/dashboard/warnings/dismiss", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { status: "completed", operationId: body.operationId } });
    expect(mocks.issueDashboardWarningBrowserOperation).toHaveBeenCalledWith(body);
    expect(mocks.dismissDashboardWarningBrowserOperation).toHaveBeenCalledWith(body);
  });

  it("returns a privacy-preserving stale result when the warning changed", async () => {
    mocks.issueDashboardWarningBrowserOperation.mockResolvedValue({ status: "pending", operationId: body.operationId });
    mocks.dismissDashboardWarningBrowserOperation.mockResolvedValue({ status: "stale", operationId: body.operationId, code: "stale_target" });
    const response = await POST(new Request("http://localhost/api/dashboard/warnings/dismiss", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { status: "stale", operationId: body.operationId } });
    expect(mocks.dismissDashboardWarningBrowserOperation).toHaveBeenCalledWith(body);
  });

  it("maps an expected operation conflict without exposing its reason", async () => {
    mocks.issueDashboardWarningBrowserOperation.mockRejectedValue(new Error("idempotency_conflict"));
    mocks.browserOperationFailureResult.mockReturnValue({
      status: "rejected",
      operationId: body.operationId,
      code: "idempotency_conflict"
    });
    const response = await POST(new Request("http://localhost/api/dashboard/warnings/dismiss", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { status: "rejected", operationId: body.operationId } });
    expect(mocks.dismissDashboardWarningBrowserOperation).not.toHaveBeenCalled();
  });
});
