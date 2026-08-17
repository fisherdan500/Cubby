import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issueInviteRevokeBrowserOperation: vi.fn(),
  submitInviteRevokeBrowserOperation: vi.fn(),
  revokeInvite: vi.fn(),
  browserOperationFailureResult: vi.fn()
}));
vi.mock("@/server/services/invites", () => ({
  issueInviteRevokeBrowserOperation: mocks.issueInviteRevokeBrowserOperation,
  submitInviteRevokeBrowserOperation: mocks.submitInviteRevokeBrowserOperation,
  revokeInvite: mocks.revokeInvite
}));
vi.mock("@/server/services/browser-operations", () => ({
  browserOperationFailureResult: mocks.browserOperationFailureResult
}));

import { POST } from "./route";

const operationId = "bmo_0123456789abcdefghjkmnpqrs";

beforeEach(() => vi.resetAllMocks());

describe("POST /api/invites/[token]/revoke browser-v2", () => {
  it("uses a one-shot invite-bound operation and returns only its nonsecret result", async () => {
    mocks.issueInviteRevokeBrowserOperation.mockResolvedValue({ status: "open", operationId, bindingId: "binding-1" });
    mocks.submitInviteRevokeBrowserOperation.mockResolvedValue({
      status: "completed", operationId, outcome: { kind: "invite", code: "revoked", inviteId: "invite-1" }
    });

    const response = await POST(new Request("http://localhost/api/invites/invite-1/revoke", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId })
    }), { params: { token: "invite-1" } });

    expect(await response.json()).toEqual({
      ok: true,
      data: { status: "completed", operationId, outcome: { kind: "invite", code: "revoked", inviteId: "invite-1" } }
    });
    expect(mocks.issueInviteRevokeBrowserOperation).toHaveBeenCalledWith({ operationId, inviteId: "invite-1" });
    expect(mocks.submitInviteRevokeBrowserOperation).toHaveBeenCalledWith({ operationId, inviteId: "invite-1" });
  });

  it("keeps the legacy revoke path when no browser operation id is supplied", async () => {
    mocks.revokeInvite.mockResolvedValue({ id: "invite-1", status: "revoked" });

    await POST(new Request("http://localhost/api/invites/invite-1/revoke", { method: "POST" }), { params: { token: "invite-1" } });

    expect(mocks.revokeInvite).toHaveBeenCalledWith("invite-1");
    expect(mocks.issueInviteRevokeBrowserOperation).not.toHaveBeenCalled();
  });
});
