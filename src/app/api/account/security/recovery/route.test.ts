import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireContext: vi.fn(), prisma: {}, key: "key", client: "client",
  issueGrant: vi.fn(), issueCodes: vi.fn(), acknowledge: vi.fn(), rehearse: vi.fn(), status: vi.fn(),
  auth: { $context: Promise.resolve({ password: { verify: vi.fn() } }) }
}));
vi.mock("@/server/auth/session", () => ({ requireGlobalSecurityContext: mocks.requireContext }));
vi.mock("@/server/services/global-security", () => ({ issueFreshAuthGrantForCurrentPassword: mocks.issueGrant }));
vi.mock("@/server/services/recovery-lifecycle", () => ({ issueRecoveryCodeSet: mocks.issueCodes, acknowledgeRecoveryCodeSetSaved: mocks.acknowledge, rehearseRecoveryCodeSet: mocks.rehearse, getRecoveryEnrollmentStatus: mocks.status }));
vi.mock("@/server/services/global-security-throttling", () => ({ canonicalizeTrustedClient: () => mocks.client, configuredGlobalSecurityThrottleKey: () => mocks.key }));
vi.mock("@/lib/auth/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/env", () => ({ env: { CUBBY_TRUSTED_PROXY_HOPS: 0 } }));

import { POST } from "@/app/api/account/security/recovery/route";

const operationId = "gso_0123456789abcdefghjkmnpqrs";
const fingerprints = { operationId, openingFingerprint: "a".repeat(64), intentFingerprint: "b".repeat(64) };
const request = (body: unknown) => new Request("http://localhost/api/account/security/recovery", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/account/security/recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireContext.mockResolvedValue({ userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    mocks.issueGrant.mockResolvedValue({ operationId, grantId: "grant-1" });
    mocks.issueCodes.mockResolvedValue({ operationId, setVersion: 2, codes: ["display-once-code"] });
    mocks.acknowledge.mockResolvedValue({ operationId, setVersion: 2, state: "rehearsal_required" });
    mocks.rehearse.mockResolvedValue({ operationId, setVersion: 2, state: "rehearsed", remainingCodes: 9 });
    mocks.status.mockResolvedValue({ operationId, setVersion: 2, state: "rehearsed", status: "completed", outcomeCode: "rehearsal_completed", remainingCodes: 9, terminalAt: null });
  });

  it("returns codes only for the deliberate display-once enrollment response", async () => {
    const response = await POST(request({ ...fingerprints, action: "enroll", currentPassword: "current password" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { operationId, setVersion: 2, codes: ["display-once-code"], displayOnce: true } });
    expect(mocks.issueGrant).toHaveBeenCalledWith(mocks.prisma, expect.objectContaining({ userId: "user-1" }), expect.objectContaining({ purpose: "recovery_enrollment" }), "current password", expect.anything(), undefined, undefined, expect.anything());
    expect(mocks.issueCodes).toHaveBeenCalledOnce();
  });

  it("keeps acknowledgements, rehearsal, and status metadata-only", async () => {
    const responses = await Promise.all([
      POST(request({ operationId, action: "acknowledge", setVersion: 2 })),
      POST(request({ ...fingerprints, action: "rehearse", setVersion: 2, code: "one recovery code" })),
      POST(request({ ...fingerprints, action: "status" }))
    ]);
    for (const response of responses) expect(JSON.stringify(await response.json())).not.toMatch(/display-once-code|one recovery code|current password/i);
    expect(mocks.acknowledge).toHaveBeenCalledOnce();
    expect(mocks.rehearse).toHaveBeenCalledOnce();
    expect(mocks.status).toHaveBeenCalledOnce();
  });

  it("rejects unknown actions before resolving the authenticated user", async () => {
    const response = await POST(request({ ...fingerprints, action: "send_email" }));
    expect(response.status).toBe(422);
    expect(mocks.requireContext).not.toHaveBeenCalled();
  });
});
