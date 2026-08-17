import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revokeAllPendingInvites: vi.fn(),
  issueInviteRevokeAllBrowserOperation: vi.fn(),
  submitInviteRevokeAllBrowserOperation: vi.fn(),
  browserOperationFailureResult: vi.fn()
}));

vi.mock("@/server/services/invites", () => ({
  revokeAllPendingInvites: mocks.revokeAllPendingInvites,
  issueInviteRevokeAllBrowserOperation: mocks.issueInviteRevokeAllBrowserOperation,
  submitInviteRevokeAllBrowserOperation: mocks.submitInviteRevokeAllBrowserOperation
}));
vi.mock("@/server/services/browser-operations", () => ({ browserOperationFailureResult: mocks.browserOperationFailureResult }));

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

  it("uses the browser-v2 bulk operation when supplied", async () => {
    const operationId = "bmo_0123456789abcdefghjkmnpqrs";
    const body = { operationId, acknowledgement: "I_REVOKE_ALL_PENDING_INVITATIONS" };
    mocks.issueInviteRevokeAllBrowserOperation.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
    mocks.submitInviteRevokeAllBrowserOperation.mockResolvedValue({
      status: "completed", operationId, outcome: { kind: "invite_bulk", code: "revoked", revokedCount: 2 }
    });

    const response = await POST(new Request("http://localhost/api/invites/revoke-all", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    }));

    expect(await response.json()).toEqual({
      ok: true,
      data: { status: "completed", operationId, outcome: { kind: "invite_bulk", code: "revoked", revokedCount: 2 } }
    });
    expect(mocks.issueInviteRevokeAllBrowserOperation).toHaveBeenCalledWith(body);
    expect(mocks.submitInviteRevokeAllBrowserOperation).toHaveBeenCalledWith(body);
    expect(mocks.revokeAllPendingInvites).not.toHaveBeenCalled();
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
