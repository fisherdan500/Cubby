import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addBaby: vi.fn(),
  submitCreateBabyBrowserOperation: vi.fn()
}));
vi.mock("@/server/services/households", () => ({
  addBaby: mocks.addBaby,
  submitCreateBabyBrowserOperation: mocks.submitCreateBabyBrowserOperation
}));

import { POST } from "./route";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";

beforeEach(() => vi.resetAllMocks());

describe("POST /api/babies", () => {
  it("submits a canonical browser-v2 creation operation without the legacy write", async () => {
    mocks.submitCreateBabyBrowserOperation.mockResolvedValue({
      status: "completed", operationId, outcome: { kind: "baby_create", code: "ok", babyId: "baby-1" }
    });

    const response = await POST(new Request("http://localhost/api/babies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId, name: "Ada" })
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: {
      status: "completed", operationId, outcome: { kind: "baby_create", code: "ok", babyId: "baby-1" }
    } });
    expect(mocks.submitCreateBabyBrowserOperation).toHaveBeenCalledWith({ operationId, name: "Ada" });
    expect(mocks.addBaby).not.toHaveBeenCalled();
  });

  it("preserves the legacy create path when no browser-v2 operation identity is provided", async () => {
    mocks.addBaby.mockResolvedValue({ id: "baby-legacy", name: "Ada" });

    const response = await POST(new Request("http://localhost/api/babies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" })
    }));

    expect(await response.json()).toEqual({ ok: true, data: { id: "baby-legacy", name: "Ada" } });
    expect(mocks.addBaby).toHaveBeenCalledWith({ name: "Ada" });
    expect(mocks.submitCreateBabyBrowserOperation).not.toHaveBeenCalled();
  });
});
