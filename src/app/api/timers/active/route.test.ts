import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getActiveTimersForShell: vi.fn() }));
vi.mock("@/server/services/active-timers", () => ({ getActiveTimersForShell: mocks.getActiveTimersForShell }));

import { GET } from "@/app/api/timers/active/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getActiveTimersForShell.mockResolvedValue([]);
});

describe("GET /api/timers/active", () => {
  it("forwards the selected baby from the query string", async () => {
    mocks.getActiveTimersForShell.mockResolvedValue([{ id: "timer-1" }]);
    const response = await GET(new Request("http://localhost/api/timers/active?babyId=baby-b"));

    expect(response.status).toBe(200);
    expect(mocks.getActiveTimersForShell).toHaveBeenCalledWith("baby-b");
    expect(await response.json()).toEqual({ ok: true, data: { timers: [{ id: "timer-1" }] } });
  });

  it("requests the explicit all-babies view when no baby is selected", async () => {
    await GET(new Request("http://localhost/api/timers/active"));

    expect(mocks.getActiveTimersForShell).toHaveBeenCalledWith(undefined);
  });

  it.each([
    "http://localhost/api/timers/active?babyId=",
    "http://localhost/api/timers/active?babyId=&babyId=baby-b",
    "http://localhost/api/timers/active?babyId=baby-a&babyId=baby-b"
  ])("rejects an invalid or duplicate selected-baby query: %s", async (url) => {
    const response = await GET(new Request(url));

    expect(response.status).toBe(400);
    expect(mocks.getActiveTimersForShell).not.toHaveBeenCalled();
  });
});
