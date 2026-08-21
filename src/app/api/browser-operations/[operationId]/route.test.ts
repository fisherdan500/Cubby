import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStatus: vi.fn(), abandon: vi.fn() }));
vi.mock("@/server/services/browser-operation-status", () => ({
  getHouseholdBrowserOperationStatus: mocks.getStatus,
  abandonCurrentHouseholdBrowserOperation: mocks.abandon
}));

import { DELETE, GET } from "@/app/api/browser-operations/[operationId]/route";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";

describe("GET /api/browser-operations/:operationId", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    [{ status: "pending", operationId, code: "operation_unknown" }, 202],
    [{ status: "prepared", operationId, code: "operation_prepared" }, 202],
    [{ status: "expired", operationId, code: "operation_result_expired" }, 410],
    [{ status: "expired", operationId, code: "operation_abandoned" }, 410],
    [{ status: "completed", operationId, outcome: { kind: "calendar_event", code: "ok", eventId: "event-1" } }, 200]
  ] as const)("maps durable status %# without executing a mutation", async (result, status) => {
    mocks.getStatus.mockResolvedValue(result);
    const response = await GET(new Request(`http://localhost/api/browser-operations/${operationId}`), {
      params: { operationId }
    });
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: result });
    expect(mocks.getStatus).toHaveBeenCalledWith(operationId);
  });

  it("keeps foreign and missing identities existence-neutral", async () => {
    mocks.getStatus.mockRejectedValue(new Error("not_found"));
    const response = await GET(new Request(`http://localhost/api/browser-operations/${operationId}`), {
      params: { operationId }
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("abandons only the current session's prepared reservation and returns authorized 410", async () => {
    const result = { status: "expired", operationId, code: "operation_abandoned" } as const;
    mocks.abandon.mockResolvedValue(result);
    const response = await DELETE(new Request(`http://localhost/api/browser-operations/${operationId}`, { method: "DELETE" }), { params: { operationId } });
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: result });
    expect(mocks.abandon).toHaveBeenCalledWith(operationId);
  });
});
