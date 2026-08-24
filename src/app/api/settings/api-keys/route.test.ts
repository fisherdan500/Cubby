import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createApiKey: vi.fn(), listApiKeys: vi.fn() }));
vi.mock("@/server/services/integrations", () => ({ createApiKey: mocks.createApiKey, listApiKeys: mocks.listApiKeys }));

import { POST } from "@/app/api/settings/api-keys/route";

beforeEach(() => { vi.resetAllMocks(); mocks.createApiKey.mockRejectedValue(new Error("api_key_issuance_unavailable")); });

describe("POST /api/settings/api-keys", () => {
  it("fails closed without parsing or issuing an ordinary API key", async () => {
    const response = await POST(new Request("http://localhost/api/settings/api-keys", { method: "POST", body: "not-json" }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "api_key_issuance_unavailable" } });
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });
});
