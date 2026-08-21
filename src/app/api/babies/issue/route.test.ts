import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ issueCreateBabyBrowserOperation: vi.fn() }));
vi.mock("@/server/services/households", () => ({ issueCreateBabyBrowserOperation: mocks.issueCreateBabyBrowserOperation }));

import { POST } from "./route";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";

beforeEach(() => vi.resetAllMocks());

describe("POST /api/babies/issue", () => {
  it("opens one typed browser-v2 baby-create binding", async () => {
    mocks.issueCreateBabyBrowserOperation.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });

    const response = await POST(new Request("http://localhost/api/babies/issue", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId })
    }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true, data: { status: "open", operationId, bindingId: "binding-1" } });
    expect(mocks.issueCreateBabyBrowserOperation).toHaveBeenCalledWith({ operationId });
  });

  it("returns a server-generated prepared reservation when the browser omits an ID", async () => {
    mocks.issueCreateBabyBrowserOperation.mockResolvedValue({ status: "prepared", operationId, code: "operation_prepared" });
    const response = await POST(new Request("http://localhost/api/babies/issue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }));
    expect(response.status).toBe(202);
    expect(mocks.issueCreateBabyBrowserOperation).toHaveBeenCalledWith({});
  });
});
