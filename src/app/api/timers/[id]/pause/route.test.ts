import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pauseTimer: vi.fn() }));
vi.mock("@/server/services/activities", () => ({ pauseTimer: mocks.pauseTimer }));

import { POST } from "./route";

describe("POST /api/timers/[id]/pause", () => {
  it("forwards a supplied client mutation ID", async () => {
    mocks.pauseTimer.mockResolvedValue({ id: "activity-1" });
    const response = await POST(
      new Request("http://localhost/api/timers/activity-1/pause", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientMutationId: "22222222-2222-4222-8222-222222222222" })
      }),
      { params: { id: "activity-1" } }
    );

    expect(response.status).toBe(200);
    expect(mocks.pauseTimer).toHaveBeenCalledWith("activity-1", { clientMutationId: "22222222-2222-4222-8222-222222222222" });
  });

  it("preserves legacy empty-body compatibility", async () => {
    mocks.pauseTimer.mockResolvedValue({ id: "activity-1" });
    await POST(new Request("http://localhost/api/timers/activity-1/pause", { method: "POST" }), { params: { id: "activity-1" } });
    expect(mocks.pauseTimer).toHaveBeenCalledWith("activity-1", undefined);
  });

  it("rejects malformed non-empty JSON without invoking the timer command", async () => {
    const callCount = mocks.pauseTimer.mock.calls.length;
    const response = await POST(
      new Request("http://localhost/api/timers/activity-1/pause", { method: "POST", body: "{" }),
      { params: { id: "activity-1" } }
    );

    expect(response.status).toBe(422);
    expect(mocks.pauseTimer).toHaveBeenCalledTimes(callCount);
  });

  it.each(["null", "{}"])("rejects non-empty JSON %s without a client mutation ID", async (body) => {
    const callCount = mocks.pauseTimer.mock.calls.length;
    const response = await POST(
      new Request("http://localhost/api/timers/activity-1/pause", { method: "POST", body }),
      { params: { id: "activity-1" } }
    );

    expect(response.status).toBe(422);
    expect(mocks.pauseTimer).toHaveBeenCalledTimes(callCount);
  });
});
