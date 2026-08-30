import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireContext: vi.fn(), exportHistory: vi.fn(), prisma: {} }));
vi.mock("@/server/auth/session", () => ({ requireGlobalSecurityContext: mocks.requireContext }));
vi.mock("@/server/services/global-security-history", () => ({ exportGlobalSecurityHistory: mocks.exportHistory, globalSecurityHistoryExportFilename: "cubby-global-security-history-v1-UTC.json" }));
vi.mock("@/lib/db/prisma", () => ({ prisma: mocks.prisma }));

import { POST } from "@/app/api/account/security-history/export/route";

const request = (body: unknown, contentType = "application/json") => new Request("http://localhost/api/account/security-history/export", { method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(body) });

describe("POST /api/account/security-history/export", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireContext.mockResolvedValue({ userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 });
    mocks.exportHistory.mockResolvedValue({ schemaVersion: 1, exportType: "cubby_global_security_history", exportedAt: new Date("2026-08-29T12:00:00.000Z"), events: [] });
  });

  it("requires exact confirmation and emits a no-store deterministic attachment from the reauthorized service", async () => {
    const response = await POST(request({ confirmed: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="cubby-global-security-history-v1-UTC.json"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ schemaVersion: 1, exportType: "cubby_global_security_history", exportedAt: "2026-08-29T12:00:00.000Z", events: [] });
    expect(mocks.exportHistory).toHaveBeenCalledWith(mocks.prisma, expect.objectContaining({ userId: "user-1" }));
  });

  it.each([{ confirmed: false }, { confirmed: true, extra: true }, {}, []])("rejects non-exact confirmation before authorization", async (body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(422);
    expect(mocks.requireContext).not.toHaveBeenCalled();
  });

  it("maps the hard export cap without leaking internal rows", async () => {
    mocks.exportHistory.mockRejectedValue(new Error("security_history_export_too_large"));
    const response = await POST(request({ confirmed: true }));
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "security_history_export_too_large" } });
  });
});
