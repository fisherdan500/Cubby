import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPlatformOwnerAccount: vi.fn(),
  trustedOrigins: vi.fn()
}));

vi.mock("@/server/services/platform-setup", () => ({ createPlatformOwnerAccount: mocks.createPlatformOwnerAccount }));
vi.mock("@/lib/env", () => ({ trustedOrigins: mocks.trustedOrigins }));

import { POST } from "@/app/api/platform/setup/account/route";

const body = { code: "7F3K-92QD-XB4M-0ZHT", name: "Avery", email: "owner@example.test", password: "correct horse battery" };

function request(headers: Record<string, string>, payload: unknown = body) {
  return new Request("http://cubby.local/api/platform/setup/account", {
    method: "POST",
    headers,
    body: typeof payload === "string" ? payload : JSON.stringify(payload)
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.trustedOrigins.mockReturnValue(["https://cubby.example.test"]);
  mocks.createPlatformOwnerAccount.mockResolvedValue({ ownerUserId: "usr_first" });
});

describe("POST /api/platform/setup/account", () => {
  it.each([
    ["the app's own origin", "http://cubby.local"],
    ["a configured trusted origin", "https://cubby.example.test"]
  ])("creates the first account for a JSON request from %s", async (_label, origin) => {
    const response = await POST(request({ origin, "content-type": "application/json" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { ownerUserId: "usr_first" } });
    expect(mocks.createPlatformOwnerAccount).toHaveBeenCalledWith(body);
  });

  it.each([
    ["no origin", {}],
    ["another site's origin", { origin: "https://attacker.example" }]
  ])("refuses a request with %s before reading it", async (_label, originHeader) => {
    const response = await POST(request({ ...originHeader, "content-type": "application/json" }));

    expect(response.status).toBe(403);
    expect(mocks.createPlatformOwnerAccount).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON, which a plain cross-site form could send", async () => {
    const response = await POST(request({ origin: "http://cubby.local", "content-type": "text/plain" }, JSON.stringify(body)));

    expect(response.status).toBe(422);
    expect(mocks.createPlatformOwnerAccount).not.toHaveBeenCalled();
  });

  it.each([
    ["platform_setup_install_not_empty", 409],
    ["platform_setup_account_invalid", 422],
    ["platform_setup_code_invalid", 422],
    ["platform_owner_already_bound", 409]
  ])("reports %s as %i", async (code, status) => {
    mocks.createPlatformOwnerAccount.mockRejectedValue(new Error(code));

    const response = await POST(request({ origin: "http://cubby.local", "content-type": "application/json" }));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code } });
  });
});
