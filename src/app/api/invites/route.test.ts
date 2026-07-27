import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createInvite: vi.fn()
}));

vi.mock("@/server/services/invites", () => ({ createInvite: mocks.createInvite }));

import { POST } from "@/app/api/invites/route";

describe("invite creation route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createInvite.mockResolvedValue({ id: "invite-1" });
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
