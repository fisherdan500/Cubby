import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ restoreMember: vi.fn() }));
vi.mock("@/server/services/invites", () => ({ restoreMember: mocks.restoreMember }));

import { POST } from "@/app/api/members/[id]/restore/route";

describe("POST /api/members/:id/restore", () => {
  beforeEach(() => vi.clearAllMocks());

  it("restores the requested member through the service boundary", async () => {
    mocks.restoreMember.mockResolvedValue({ id: "member-1", disabledAt: null });

    const response = await POST(new Request("http://localhost/api/members/member-1/restore", { method: "POST" }), {
      params: Promise.resolve({ id: "member-1" })
    });

    await expect(response.json()).resolves.toMatchObject({ ok: true, data: { id: "member-1" } });
    expect(mocks.restoreMember).toHaveBeenCalledWith("member-1");
  });
});
