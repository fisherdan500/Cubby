import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: { user: { findUnique: vi.fn() } },
  requireContext: vi.fn(), requireCredential: vi.fn(), clearCookies: vi.fn(),
  initiate: vi.fn(), verify: vi.fn(), cancel: vi.fn(), status: vi.fn(), complete: vi.fn(), emit: vi.fn(), confirm: vi.fn(),
  auth: { $context: Promise.resolve({ password: { verify: vi.fn() } }) }
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/auth/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/env", () => ({ env: { CUBBY_TRUSTED_PROXY_HOPS: 0 } }));
vi.mock("@/server/auth/session", () => ({ requireGlobalSecurityContext: mocks.requireContext, requireGlobalSecuritySessionCredential: mocks.requireCredential, clearBetterAuthSessionCookies: mocks.clearCookies }));
vi.mock("@/server/services/global-security-throttling", () => ({ configuredGlobalSecurityThrottleKey: () => "key", canonicalizeTrustedClient: () => "client" }));
vi.mock("@/server/services/email-change", () => ({ initiateVerifiedEmailChange: mocks.initiate, verifyEmailChangeToken: mocks.verify, cancelVerifiedEmailChange: mocks.cancel, getVerifiedEmailChangeStatus: mocks.status, completeVerifiedEmailChange: mocks.complete, emitEmailChangeSuccessorCookie: mocks.emit, confirmEmailChangeSuccessorCookieForAuthenticatedSession: mocks.confirm }));

import { POST } from "@/app/api/account/security/email-change/route";

const operationId = "gso_0123456789abcdefghjkmnpqrs";
const metadata = { operationId, openingFingerprint: "a".repeat(64), intentFingerprint: "b".repeat(64) };
const request = (body: unknown) => new Request("http://localhost/api/account/security/email-change", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/account/security/email-change", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireContext.mockResolvedValue({ userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    mocks.requireCredential.mockResolvedValue({ userId: "user-1", sessionId: "session-1", sessionToken: "old-token", credentialVersion: 1, sessionSecurityVersion: 1 });
    mocks.initiate.mockResolvedValue({ operationId, status: "pending" });
    mocks.verify.mockResolvedValue({ operationId, status: "verified" });
    mocks.cancel.mockResolvedValue({ operationId, status: "cancelled" });
    mocks.status.mockResolvedValue({ operationId, status: "verified", oldAddressNoticeFailed: false, cookieState: "issued" });
    mocks.complete.mockResolvedValue({ operationId, status: "completed" });
    mocks.prisma.user.findUnique.mockResolvedValue({ id: "user-1", email: "new@example.test", name: "Person", image: null, emailVerified: true });
    mocks.emit.mockResolvedValue({ operationId, status: "issued" });
    mocks.confirm.mockResolvedValue({ operationId, status: "confirmed" });
  });

  it("starts a verified change with current-password proof and does not expose the new address", async () => {
    const response = await POST(request({ ...metadata, action: "initiate", currentPassword: "current password", newEmail: "new@example.test" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { operationId, status: "pending" } });
    expect(mocks.initiate).toHaveBeenCalledWith(mocks.prisma, expect.objectContaining({ userId: "user-1" }), expect.objectContaining(metadata), "current password", expect.anything());
    expect(JSON.stringify(await (await POST(request({ ...metadata, action: "status" }))).json())).not.toMatch(/new@example|old-token/i);
  });

  it("accepts verification material only as manual input and completes the successor-cookie closure", async () => {
    const verified = await POST(request({ operationId, action: "verify", verification: "manual verification material" }));
    expect(verified.status).toBe(200);
    expect(mocks.verify).toHaveBeenCalledWith(mocks.prisma, { userId: "user-1", operationId, token: "manual verification material" });
    const cutover = await POST(request({ operationId, action: "cutover" }));
    expect(cutover.status).toBe(200);
    await expect(cutover.json()).resolves.toEqual({ ok: true, data: { operationId, status: "issued", signInRequired: false } });
    expect(mocks.complete).toHaveBeenCalledWith(mocks.prisma, expect.objectContaining({ userId: "user-1", oldSessionId: "session-1" }));
    expect(mocks.emit).toHaveBeenCalledOnce();
  });

  it("rejects URL-shaped verification and unknown actions before authentication", async () => {
    const response = await POST(request({ operationId, action: "verify", verification: "https://example.test/?token=secret" }));
    expect(response.status).toBe(422);
    expect(mocks.requireContext).not.toHaveBeenCalled();
  });
});
