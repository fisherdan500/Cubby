import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revokeAllPendingInvites: vi.fn()
}));

vi.mock("@/server/services/invites", () => ({
  revokeAllPendingInvites: mocks.revokeAllPendingInvites
}));

import { POST } from "@/app/api/invites/revoke-all/route";

describe("bulk invitation revocation route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.revokeAllPendingInvites.mockResolvedValue({ revokedCount: 2 });
  });

  it("passes the explicit request body to the service", async () => {
    const request = new Request("http://localhost/api/invites/revoke-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acknowledgement: "I_REVOKE_ALL_PENDING_INVITATIONS" })
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mocks.revokeAllPendingInvites).toHaveBeenCalledWith({
      acknowledgement: "I_REVOKE_ALL_PENDING_INVITATIONS"
    });
  });

  it("rejects malformed JSON as a client error", async () => {
    const request = new Request("http://localhost/api/invites/revoke-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mocks.revokeAllPendingInvites).not.toHaveBeenCalled();
  });
});
