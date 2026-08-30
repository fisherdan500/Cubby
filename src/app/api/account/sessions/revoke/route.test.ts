import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireContext: vi.fn(),
  revoke: vi.fn(),
  recordQualifyingUse: vi.fn(),
  configuredKey: vi.fn(),
  canonicalClient: vi.fn(),
  verify: vi.fn(),
  clearCookies: vi.fn(),
  prisma: {}
}));

vi.mock("@/server/auth/session", () => ({
  requireGlobalSecurityContext: mocks.requireContext,
  clearBetterAuthSessionCookies: mocks.clearCookies
}));
vi.mock("@/server/services/global-session-security", () => ({
  revokeGlobalSessionSecurityWithCurrentPassword: mocks.revoke,
  recordQualifyingGlobalSessionUseAfterSuccess: mocks.recordQualifyingUse
}));
vi.mock("@/lib/auth/auth", () => ({
  auth: { $context: Promise.resolve({ password: { verify: mocks.verify } }) }
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/env", () => ({ env: { CUBBY_TRUSTED_PROXY_HOPS: 0 } }));
vi.mock("@/server/services/global-security-throttling", () => ({ configuredGlobalSecurityThrottleKey: mocks.configuredKey, canonicalizeTrustedClient: mocks.canonicalClient }));

import { POST } from "@/app/api/account/sessions/revoke/route";

const operationId = "gso_00000000000000000000000000";
const openingFingerprint = "1".repeat(64);
const intentFingerprint = "2".repeat(64);
const context = { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 };

function request(body: unknown) {
  return new Request("http://localhost/api/account/sessions/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("POST /api/account/sessions/revoke", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.configuredKey.mockReturnValue("K".repeat(43));
    mocks.canonicalClient.mockReturnValue("unknown_client");
    mocks.requireContext.mockResolvedValue(context);
    mocks.revoke.mockResolvedValue({ operationId, status: "revoked" });
  });

  it("submits one exact non-current target with current-password verification at the server session boundary", async () => {
    const input = {
      operationId,
      openingFingerprint,
      intentFingerprint,
      scope: "one",
      targetHandle: "A".repeat(30),
      confirmed: true,
      currentPassword: "current-password"
    };

    const response = await POST(request(input));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { operationId, status: "revoked", signedOut: false } });
    expect(mocks.revoke).toHaveBeenCalledWith(
      mocks.prisma,
      context,
      {
        operationId,
        openingFingerprint,
        intentFingerprint,
        scope: "one",
        targetHandle: "A".repeat(30),
        confirmed: true
      },
      "current-password",
      { verify: mocks.verify },
      undefined,
      { key: "K".repeat(43), client: "unknown_client" }
    );
    expect(mocks.recordQualifyingUse).toHaveBeenCalledWith(mocks.prisma, context, "private_security_action");
    expect(mocks.clearCookies).not.toHaveBeenCalled();
  });

  it.each([
    ["requires explicit confirmation", { operationId, openingFingerprint, intentFingerprint, scope: "others", confirmed: false, currentPassword: "current-password" }],
    ["requires a target for current", { operationId, openingFingerprint, intentFingerprint, scope: "current", confirmed: true, currentPassword: "current-password" }],
    ["forbids a target for all", { operationId, openingFingerprint, intentFingerprint, scope: "all", targetHandle: "unexpected", confirmed: true, currentPassword: "current-password" }],
    ["rejects extra keys", { operationId, openingFingerprint, intentFingerprint, scope: "others", confirmed: true, currentPassword: "current-password", token: "must-not-be-accepted" }],
    ["rejects malformed operation IDs", { operationId: "gso_invalid", openingFingerprint, intentFingerprint, scope: "others", confirmed: true, currentPassword: "current-password" }],
    ["rejects malformed fingerprints", { operationId, openingFingerprint: "short", intentFingerprint, scope: "others", confirmed: true, currentPassword: "current-password" }]
  ])("%s before authentication or service work", async (_name, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "session_revoke_request_invalid", message: "Check the session revocation request and try again." }
    });
    expect(mocks.requireContext).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it.each(["current", "all"] as const)("clears every Better Auth session carrier after a successful %s revoke", async (scope) => {
    const response = await POST(request({
      operationId,
      openingFingerprint,
      intentFingerprint,
      scope,
      ...(scope === "current" ? { targetHandle: "C".repeat(30) } : {}),
      confirmed: true,
      currentPassword: "current-password"
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { signedOut: true } });
    expect(mocks.clearCookies).toHaveBeenCalledOnce();
  });

  it.each([
    ["current_password_invalid", 422, "current_password_invalid", "The current password is incorrect."],
    ["stale_security_version", 409, "session_revoke_stale", "Your security state changed. Sign in again before retrying."],
    ["idempotency_conflict", 409, "session_revoke_conflict", "This revocation request no longer matches its original action."],
    ["operation_outcome_unknown", 409, "session_revoke_status_required", "Check the authoritative revocation status before retrying."],
    ["unauthenticated", 401, "unauthenticated", "Please sign in."]
  ])("maps %s to a stable sanitized response", async (serviceError, status, code, message) => {
    mocks.revoke.mockRejectedValue(new Error(serviceError));

    const response = await POST(request({ operationId, openingFingerprint, intentFingerprint, scope: "others", confirmed: true, currentPassword: "current-password" }));

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ ok: false, error: { code, message } });
  });
});
