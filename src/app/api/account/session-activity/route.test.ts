import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ context: vi.fn(), record: vi.fn(), prisma: {} }));
vi.mock("@/server/auth/session", () => ({ requireGlobalSecurityContext: mocks.context }));
vi.mock("@/server/services/global-session-security", () => ({ recordQualifyingGlobalSessionUseAfterSuccess: mocks.record }));
vi.mock("@/lib/db/prisma", () => ({ prisma: mocks.prisma }));

import { POST } from "@/app/api/account/session-activity/route";

describe("POST /api/account/session-activity", () => {
  beforeEach(() => vi.resetAllMocks());

  it("records only a validated post-render foreground navigation", async () => {
    const context = { userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 };
    mocks.context.mockResolvedValue(context);
    const response = await POST(new Request("http://localhost/api/account/session-activity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestClass: "foreground_document_navigation" }) }));
    expect(response.status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith(mocks.prisma, context, "foreground_document_navigation");
  });

  it("rejects unknown and expanded request classes before authorization", async () => {
    const response = await POST(new Request("http://localhost/api/account/session-activity", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestClass: "background", extra: true }) }));
    expect(response.status).toBe(422);
    expect(mocks.context).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
