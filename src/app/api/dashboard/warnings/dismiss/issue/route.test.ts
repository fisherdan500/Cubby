import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issue: vi.fn(),
  failure: vi.fn()
}));
vi.mock("@/server/services/dashboard", () => ({ issueDashboardWarningBrowserOperation: mocks.issue }));
vi.mock("@/server/services/browser-operations", () => ({ browserOperationFailureResult: mocks.failure }));

import { POST } from "@/app/api/dashboard/warnings/dismiss/issue/route";

const body = { babyId: "baby-1", type: "feeding", fingerprint: "warning-fingerprint" };

describe("dashboard warning reservation route", () => {
  beforeEach(() => { vi.resetAllMocks(); });

  it("returns the server-issued prepared reservation without submitting a dismissal", async () => {
    mocks.issue.mockResolvedValue({ status: "prepared", operationId: "bmo_0123456789abcdefghjkmnpqrs", code: "operation_prepared" });
    const response = await POST(new Request("http://localhost/api/dashboard/warnings/dismiss/issue", { method: "POST", body: JSON.stringify(body) }));
    expect(response.status).toBe(202);
    expect(mocks.issue).toHaveBeenCalledWith(body);
    expect(await response.json()).toEqual({ ok: true, data: { status: "prepared", operationId: "bmo_0123456789abcdefghjkmnpqrs", code: "operation_prepared" } });
  });
});
