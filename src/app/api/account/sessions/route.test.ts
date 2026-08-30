import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireContext: vi.fn(),
  list: vi.fn(),
  prisma: {}
}));

vi.mock("@/server/auth/session", () => ({
  requireGlobalSecurityContext: mocks.requireContext
}));
vi.mock("@/server/services/global-session-security", () => ({
  listGlobalSessionSecurity: mocks.list
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: mocks.prisma }));

import { GET } from "@/app/api/account/sessions/route";

describe("GET /api/account/sessions", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns only the authenticated global user's safe session projection without household authorization", async () => {
    const context = { userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 };
    const session = {
      handle: "opaque-handle",
      isCurrent: true,
      deviceLabel: "Chrome on Windows",
      createdAt: new Date("2026-08-01T12:00:00.000Z"),
      lastQualifyingAt: new Date("2026-08-29T12:00:00.000Z"),
      idleWarningAt: null,
      expiresAt: new Date("2026-09-01T12:00:00.000Z")
    };
    mocks.requireContext.mockResolvedValue(context);
    mocks.list.mockResolvedValue([session]);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { sessions: [{
      ...session,
      createdAt: "2026-08-01T12:00:00.000Z",
      lastQualifyingAt: "2026-08-29T12:00:00.000Z",
      expiresAt: "2026-09-01T12:00:00.000Z"
    }] } });
    expect(mocks.requireContext).toHaveBeenCalledOnce();
    expect(mocks.list).toHaveBeenCalledWith(mocks.prisma, context);
    expect(JSON.stringify(await (await GET()).json())).not.toMatch(/household|token|ipAddress|userAgent|sessionId|internalId/i);
  });
});
