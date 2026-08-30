import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireContext: vi.fn(), status: vi.fn(), recordQualifyingUse: vi.fn(), prisma: {} }));
vi.mock("@/server/auth/session", () => ({ requireGlobalSecurityContext: mocks.requireContext }));
vi.mock("@/server/services/global-session-security", () => ({ getGlobalSessionRevokeStatus: mocks.status, recordQualifyingGlobalSessionUseAfterSuccess: mocks.recordQualifyingUse }));
vi.mock("@/lib/db/prisma", () => ({ prisma: mocks.prisma }));

import { POST } from "@/app/api/account/sessions/status/route";

const body = { operationId: "gso_00000000000000000000000000", openingFingerprint: "a".repeat(64), intentFingerprint: "b".repeat(64) };

describe("POST /api/account/sessions/status", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns only authoritative same-user revocation metadata", async () => {
    const context = { userId: "user-1", sessionId: "session-2", credentialVersion: 2, sessionSecurityVersion: 4 };
    mocks.requireContext.mockResolvedValue(context);
    mocks.status.mockResolvedValue({ operationId: body.operationId, status: "revoked" });

    const response = await POST(new Request("http://localhost/api/account/sessions/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { operationId: body.operationId, status: "revoked" } });
    expect(mocks.status).toHaveBeenCalledWith(mocks.prisma, context, body);
    expect(mocks.recordQualifyingUse).toHaveBeenCalledWith(mocks.prisma, context, "private_security_action");
  });

  it("rejects unknown or malformed fields without invoking status", async () => {
    const response = await POST(new Request("http://localhost/api/account/sessions/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, extra: true }) }));
    expect(response.status).toBe(422);
    expect(mocks.status).not.toHaveBeenCalled();
  });
});
