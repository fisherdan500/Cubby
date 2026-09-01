import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: { $queryRaw: vi.fn(), accountSecurityState: { findUnique: vi.fn() } },
  recover: vi.fn(), neutralWork: vi.fn(), precheck: vi.fn(), recordFailure: vi.fn(), clearCookies: vi.fn(), hash: vi.fn(), key: "test-key", client: "client"
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/auth/auth", () => ({ auth: { $context: Promise.resolve({ password: { hash: mocks.hash } }) } }));
vi.mock("@/server/auth/session", () => ({ clearBetterAuthSessionCookies: mocks.clearCookies }));
vi.mock("@/server/services/recovery-lifecycle", () => ({ recoverPasswordWithCode: mocks.recover }));
vi.mock("@/server/services/recovery-codes", () => ({ performNeutralRecoveryCodeVerification: mocks.neutralWork }));
vi.mock("@/server/services/global-security-throttling", () => ({ configuredGlobalSecurityThrottleKey: () => mocks.key, canonicalizeTrustedClient: () => mocks.client, precheckGlobalSecurityThrottle: mocks.precheck, recordGlobalSecurityThrottleFailure: mocks.recordFailure }));
vi.mock("@/lib/env", () => ({ env: { CUBBY_TRUSTED_PROXY_HOPS: 0 } }));

import { POST } from "@/app/api/account/recovery/reset/route";

const body = { email: "person@example.test", code: "offline code", newPassword: "a new password", operationId: "gso_0123456789abcdefghjkmnpqrs", openingFingerprint: "a".repeat(64), intentFingerprint: "b".repeat(64) };
const request = (value: unknown) => new Request("http://localhost/api/account/recovery/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });

describe("POST /api/account/recovery/reset", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.prisma.$queryRaw.mockResolvedValue([{ id: "user-1" }]);
    mocks.prisma.accountSecurityState.findUnique.mockResolvedValue({ credentialVersion: 2, sessionSecurityVersion: 3 });
    mocks.hash.mockResolvedValue("hash");
    mocks.precheck.mockResolvedValue({ quiet: false, deadline: null });
    mocks.recordFailure.mockResolvedValue({ quiet: false, deadline: null });
    mocks.recover.mockResolvedValue({ operationId: body.operationId, recoverySessionId: "recovery-1", status: "signed_out" });
  });

  it("performs only a restricted recovery reset and always requires normal sign-in afterwards", async () => {
    const response = await POST(request(body));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { status: "submitted", signInRequired: true } });
    expect(mocks.recover).toHaveBeenCalledWith(mocks.prisma, expect.objectContaining({ userId: "user-1", code: body.code, credentialVersion: 2, sessionSecurityVersion: 3 }), body.newPassword, expect.anything(), undefined, undefined, { key: "test-key", client: "client" });
    expect(mocks.clearCookies).toHaveBeenCalledOnce();
  });

  it("gives an unknown identity the same neutral response without exposing an account", async () => {
    mocks.prisma.$queryRaw.mockResolvedValue([]);
    const response = await POST(request(body));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { status: "submitted", signInRequired: true } });
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.prisma.accountSecurityState.findUnique).toHaveBeenCalledWith({ where: { userId: "cubby-absent-recovery-user" }, select: { credentialVersion: true, sessionSecurityVersion: true } });
    expect(mocks.neutralWork).toHaveBeenCalledWith(body.code);
    expect(mocks.hash).toHaveBeenCalledWith(body.newPassword);
    expect(mocks.precheck).toHaveBeenCalledWith(mocks.prisma, { key: "test-key", client: "client" });
    expect(mocks.recordFailure).toHaveBeenCalledWith(mocks.prisma, { key: "test-key", client: "client" });
    expect(JSON.stringify(await (await POST(request(body))).json())).not.toMatch(/person@example|user-1|offline code/i);
  });
});
