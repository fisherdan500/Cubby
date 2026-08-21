import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createInvite: vi.fn(),
  issueInviteCreateBrowserOperation: vi.fn(),
  submitInviteCreateBrowserOperation: vi.fn(),
  browserOperationFailureResult: vi.fn()
}));

vi.mock("@/server/services/invites", () => ({
  createInvite: mocks.createInvite,
  issueInviteCreateBrowserOperation: mocks.issueInviteCreateBrowserOperation,
  submitInviteCreateBrowserOperation: mocks.submitInviteCreateBrowserOperation
}));
vi.mock("@/server/services/browser-operations", () => ({ browserOperationFailureResult: mocks.browserOperationFailureResult }));

import { POST } from "@/app/api/invites/route";

describe("invite creation route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createInvite.mockResolvedValue({ id: "invite-1" });
  });

  it("returns a server-issued reservation from issue-only mode without submitting", async () => {
    const body = { email: "invitee@example.test", role: "parent" };
    mocks.issueInviteCreateBrowserOperation.mockResolvedValue({ status: "prepared", operationId: "bmo_0123456789abcdefghjkmnpqrs", code: "operation_prepared" });
    const response = await POST(new Request("http://localhost/api/invites?issue=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(response.status).toBe(202);
    expect(mocks.issueInviteCreateBrowserOperation).toHaveBeenCalledWith(body);
    expect(mocks.submitInviteCreateBrowserOperation).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON as a client error", async () => {
    const request = new Request("http://localhost/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mocks.createInvite).not.toHaveBeenCalled();
  });
});
