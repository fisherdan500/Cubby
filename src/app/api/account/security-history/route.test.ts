import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireContext: vi.fn(), list: vi.fn(), prisma: {} }));
vi.mock("@/server/auth/session", () => ({ requireGlobalSecurityContext: mocks.requireContext }));
vi.mock("@/server/services/global-security-history", () => ({
  listGlobalSecurityHistory: mocks.list,
  parseGlobalSecurityHistoryLimit: (value: string | null) => {
    if (value === null) return 50;
    if (!/^(?:[1-9][0-9]{0,2})$/.test(value) || Number(value) > 100) throw new Error("security_history_query_invalid");
    return Number(value);
  }
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: mocks.prisma }));

import { GET } from "@/app/api/account/security-history/route";

describe("GET /api/account/security-history", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireContext.mockResolvedValue({ userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 });
    mocks.list.mockResolvedValue({ events: [], nextCursor: null });
  });

  it("uses only the captured global user context and returns the private service projection", async () => {
    const response = await GET(new Request("http://localhost/api/account/security-history?limit=25&cursor=opaque"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { events: [], nextCursor: null } });
    expect(mocks.list).toHaveBeenCalledWith(mocks.prisma, expect.objectContaining({ userId: "user-1" }), { limit: 25, cursor: "opaque" });
    expect(JSON.stringify(await (await GET(new Request("http://localhost/api/account/security-history"))).json())).not.toMatch(/household|sessionId|operationId|sequence/i);
  });

  it.each(["?limit=0", "?limit=01", "?cursor=", "?limit=1&limit=2", "?householdId=other"]) ("rejects strict query %s before authorization", async (query) => {
    const response = await GET(new Request(`http://localhost/api/account/security-history${query}`));
    expect(response.status).toBe(422);
    expect(mocks.requireContext).not.toHaveBeenCalled();
  });

  it("maps a malformed or foreign opaque cursor to the stable 422 response", async () => {
    mocks.list.mockRejectedValue(new Error("security_history_cursor_invalid"));
    const response = await GET(new Request("http://localhost/api/account/security-history?cursor=bad"));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "security_history_cursor_invalid" } });
  });
});
