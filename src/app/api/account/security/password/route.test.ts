import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireContext: vi.fn(),
  clearCookies: vi.fn(),
  changePassword: vi.fn(),
  auth: { $context: Promise.resolve({ password: { verify: vi.fn(), hash: vi.fn() } }) },
  prisma: {},
  key: "test-key",
  client: "client"
}));

vi.mock("@/server/auth/session", () => ({ requireGlobalSecurityContext: mocks.requireContext, clearBetterAuthSessionCookies: mocks.clearCookies }));
vi.mock("@/server/services/global-security", () => ({ changePasswordWithCurrentPassword: mocks.changePassword }));
vi.mock("@/server/services/global-security-throttling", () => ({ canonicalizeTrustedClient: () => mocks.client, configuredGlobalSecurityThrottleKey: () => mocks.key }));
vi.mock("@/lib/auth/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/env", () => ({ env: { CUBBY_TRUSTED_PROXY_HOPS: 0 } }));

import { POST } from "@/app/api/account/security/password/route";

const request = (value: unknown) => new Request("http://localhost/api/account/security/password", {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
  body: JSON.stringify(value)
});

const valid = {
  operationId: "gso_0123456789abcdefghjkmnpqrs",
  openingFingerprint: "a".repeat(64),
  intentFingerprint: "b".repeat(64),
  currentPassword: "current password",
  newPassword: "new password"
};

describe("POST /api/account/security/password", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireContext.mockResolvedValue({ userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    mocks.changePassword.mockResolvedValue({ operationId: valid.operationId, status: "signed_out" });
  });

  it("uses the global user context, never returns credentials, and closes the initiating session", async () => {
    const response = await POST(request(valid));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { operationId: valid.operationId, status: "signed_out", signInRequired: true } });
    expect(mocks.changePassword).toHaveBeenCalledWith(mocks.prisma, expect.objectContaining({ userId: "user-1" }), expect.objectContaining({ operationId: valid.operationId }), valid.currentPassword, valid.newPassword, expect.anything(), expect.anything(), undefined, { key: "test-key", client: "client" });
    expect(mocks.clearCookies).toHaveBeenCalledOnce();
  });

  it.each([
    {},
    { ...valid, extra: true },
    { ...valid, operationId: "wrong" },
    { ...valid, currentPassword: "" },
    { ...valid, newPassword: "" }
  ])("rejects malformed input before authentication", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(422);
    expect(mocks.requireContext).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toMatch(/current password|new password/i);
  });
});
