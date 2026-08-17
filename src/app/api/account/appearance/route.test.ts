import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAppearance: vi.fn(),
  issue: vi.fn(),
  submit: vi.fn()
}));
vi.mock("@/server/services/account-appearance", () => ({
  getAccountAppearance: mocks.getAppearance,
  issueAccountAppearanceBrowserOperation: mocks.issue,
  submitAccountAppearanceBrowserOperation: mocks.submit
}));

import { GET, PATCH } from "@/app/api/account/appearance/route";
import { POST } from "@/app/api/account/appearance/issue/route";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const json = (url: string, method: string, body: unknown) => new Request(url, {
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

describe("account appearance routes", () => {
  beforeEach(() => vi.resetAllMocks());

  it("reads the current personal account preference", async () => {
    mocks.getAppearance.mockResolvedValue({ appearanceMode: "system", appearanceRevision: 0 });
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { appearanceMode: "system" } });
  });

  it("issues and submits one durable account operation", async () => {
    mocks.issue.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
    const issued = await POST(json("http://localhost/api/account/appearance/issue", "POST", { operationId }));
    expect(issued.status).toBe(201);

    mocks.submit.mockResolvedValue({ status: "completed", operationId, outcome: { kind: "account_appearance", code: "ok", appearanceMode: "dark", appearanceRevision: 1 } });
    const submitted = await PATCH(json("http://localhost/api/account/appearance", "PATCH", { operationId, appearanceMode: "dark" }));
    expect(submitted.status).toBe(200);
    expect(mocks.submit).toHaveBeenCalledWith({ operationId, appearanceMode: "dark" });
  });
});
