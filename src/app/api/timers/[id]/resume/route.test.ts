import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resumeTimer: vi.fn() }));
vi.mock("@/server/services/activities", () => ({ resumeTimer: mocks.resumeTimer }));

import { POST } from "./route";

describe("POST /api/timers/[id]/resume", () => {
  it("forwards a supplied client mutation ID", async () => {
    mocks.resumeTimer.mockResolvedValue({ id: "activity-1" });
    const response = await POST(
      new Request("http://localhost/api/timers/activity-1/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientMutationId: "33333333-3333-4333-8333-333333333333" })
      }),
      { params: { id: "activity-1" } }
    );

    expect(response.status).toBe(200);
    expect(mocks.resumeTimer).toHaveBeenCalledWith("activity-1", { clientMutationId: "33333333-3333-4333-8333-333333333333" });
  });

  it("preserves legacy empty-body compatibility", async () => {
    mocks.resumeTimer.mockResolvedValue({ id: "activity-1" });
    await POST(new Request("http://localhost/api/timers/activity-1/resume", { method: "POST" }), { params: { id: "activity-1" } });
    expect(mocks.resumeTimer).toHaveBeenCalledWith("activity-1", undefined);
  });
});
