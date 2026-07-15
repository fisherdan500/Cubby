import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ suspendMember: vi.fn() }));
vi.mock("@/server/services/invites", () => ({ suspendMember: mocks.suspendMember }));

import { POST } from "@/app/api/members/[id]/suspend/route";

describe("POST /api/members/:id/suspend", () => {
  beforeEach(() => vi.clearAllMocks());

  it("suspends the requested member through the service boundary", async () => {
    mocks.suspendMember.mockResolvedValue({ id: "member-1", disabledAt: new Date() });

    const response = await POST(new Request("http://localhost/api/members/member-1/suspend", { method: "POST" }), {
      params: Promise.resolve({ id: "member-1" })
    });

    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { id: "member-1" } });
    expect(mocks.suspendMember).toHaveBeenCalledWith("member-1");
  });
});
