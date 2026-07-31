import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ stopTimer: vi.fn() }));
vi.mock("@/server/services/activities", () => ({ stopTimer: mocks.stopTimer }));

import { POST } from "./route";

describe("POST /api/timers/[id]/stop", () => {
  it("forwards a supplied client mutation ID", async () => {
    mocks.stopTimer.mockResolvedValue({ id: "activity-1" });
    const response = await POST(
      new Request("http://localhost/api/timers/activity-1/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientMutationId: "11111111-1111-4111-8111-111111111111" })
      }),
      { params: { id: "activity-1" } }
    );

    expect(response.status).toBe(200);
    expect(mocks.stopTimer).toHaveBeenCalledWith("activity-1", { clientMutationId: "11111111-1111-4111-8111-111111111111" });
  });

  it("preserves legacy empty-body compatibility", async () => {
    mocks.stopTimer.mockResolvedValue({ id: "activity-1" });
    await POST(new Request("http://localhost/api/timers/activity-1/stop", { method: "POST" }), { params: { id: "activity-1" } });
    expect(mocks.stopTimer).toHaveBeenCalledWith("activity-1", undefined);
  });

  it("rejects malformed non-empty JSON without invoking the timer command", async () => {
    const callCount = mocks.stopTimer.mock.calls.length;
    const response = await POST(
      new Request("http://localhost/api/timers/activity-1/stop", { method: "POST", body: "{" }),
      { params: { id: "activity-1" } }
    );

    expect(response.status).toBe(422);
    expect(mocks.stopTimer).toHaveBeenCalledTimes(callCount);
  });

  it.each(["null", "{}"])("rejects non-empty JSON %s without a client mutation ID", async (body) => {
    const callCount = mocks.stopTimer.mock.calls.length;
    const response = await POST(
      new Request("http://localhost/api/timers/activity-1/stop", { method: "POST", body }),
      { params: { id: "activity-1" } }
    );

    expect(response.status).toBe(422);
    expect(mocks.stopTimer).toHaveBeenCalledTimes(callCount);
  });
});
