import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStatus: vi.fn() }));
vi.mock("@/server/services/account-browser-operation-status", () => ({
  getAccountBrowserOperationStatus: mocks.getStatus
}));

import { GET } from "@/app/api/account/browser-operations/[operationId]/route";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";

describe("GET /api/account/browser-operations/:operationId", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    [{ status: "pending", operationId, code: "operation_unknown" }, 202],
    [{ status: "expired", operationId, code: "operation_result_expired" }, 410],
    [{ status: "completed", operationId, outcome: { kind: "account_appearance", code: "ok", appearanceMode: "dark", appearanceRevision: 5 } }, 200]
  ] as const)("maps account operation result %# without any household lookup", async (result, status) => {
    mocks.getStatus.mockResolvedValue(result);
    const response = await GET(new Request(`http://localhost/api/account/browser-operations/${operationId}`), {
      params: { operationId }
    });
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: result });
  });

  it("keeps foreign and missing account identities existence-neutral", async () => {
    mocks.getStatus.mockRejectedValue(new Error("not_found"));
    const response = await GET(new Request(`http://localhost/api/account/browser-operations/${operationId}`), {
      params: { operationId }
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
