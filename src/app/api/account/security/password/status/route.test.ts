import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireContext: vi.fn(), getStatus: vi.fn() }));

vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/auth/session", () => ({ requireGlobalSecurityContext: mocks.requireContext }));
vi.mock("@/server/services/global-security", () => ({ getPasswordChangeStatus: mocks.getStatus }));

import { POST } from "@/app/api/account/security/password/status/route";

const operationId = "gso_0123456789abcdefghjkmnpqrs";
const fingerprints = { openingFingerprint: "a".repeat(64), intentFingerprint: "b".repeat(64) };

describe("POST /api/account/security/password/status", () => {
  beforeEach(() => {
    mocks.requireContext.mockReset();
    mocks.getStatus.mockReset();
  });

  it("passes the current session and security-version vector to the authoritative status read", async () => {
    const context = { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 };
    mocks.requireContext.mockResolvedValue(context);
    mocks.getStatus.mockResolvedValue({ operationId, status: "completed", outcomeCode: "changed", terminalAt: null });

    const response = await POST(new Request("http://cubby.test/api/account/security/password/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId, ...fingerprints }) }));

    expect(response.status).toBe(200);
    expect(mocks.getStatus).toHaveBeenCalledWith({}, context, { operationId, ...fingerprints });
  });
});
