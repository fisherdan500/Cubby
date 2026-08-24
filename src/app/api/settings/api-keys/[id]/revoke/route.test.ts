import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ issue: vi.fn(), submit: vi.fn() }));
vi.mock("@/server/services/integrations", () => ({
  issueApiKeyRevokeBrowserOperation: mocks.issue,
  submitApiKeyRevokeBrowserOperation: mocks.submit
}));

import { POST } from "@/app/api/settings/api-keys/[id]/revoke/route";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";
const request = (url: string) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId }) });

beforeEach(() => { vi.resetAllMocks(); mocks.issue.mockResolvedValue({ status: "open", operationId }); mocks.submit.mockResolvedValue({ status: "completed", operationId, outcome: { kind: "api_key", code: "revoked" } }); });

describe("POST /api/settings/api-keys/[id]/revoke", () => {
  it("issues a target-bound revoke operation", async () => {
    const response = await POST(request("http://localhost/api/settings/api-keys/key-1/revoke?issue=1"), { params: { id: "key-1" } });
    expect(response.status).toBe(200);
    expect(mocks.issue).toHaveBeenCalledWith({ operationId, apiKeyId: "key-1" });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("submits and returns the terminal content-free outcome", async () => {
    const response = await POST(request("http://localhost/api/settings/api-keys/key-1/revoke"), { params: { id: "key-1" } });
    expect(response.status).toBe(200);
    expect(mocks.issue).toHaveBeenCalledWith({ operationId, apiKeyId: "key-1" });
    expect(mocks.submit).toHaveBeenCalledWith({ operationId, apiKeyId: "key-1" });
  });
});
