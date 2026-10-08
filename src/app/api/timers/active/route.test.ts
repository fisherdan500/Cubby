import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getActiveTimersForShell: vi.fn() }));
vi.mock("@/server/services/active-timers", () => ({ getActiveTimersForShell: mocks.getActiveTimersForShell }));

import { GET } from "@/app/api/timers/active/route";

const requestToken = "00000000-0000-4000-8000-000000000001";
const endpoint = `http://localhost/api/timers/active?requestToken=${requestToken}`;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getActiveTimersForShell.mockResolvedValue([]);
});

describe("GET /api/timers/active", () => {
  it("rejects a missing request token before loading any timer data", async () => {
    const response = await GET(new Request("http://localhost/api/timers/active"));
    expect(response.status).toBe(400);
    expect(mocks.getActiveTimersForShell).not.toHaveBeenCalled();
    expect(await response.json()).not.toHaveProperty("data.confirmedAt");
  });
  it.each(["bad", "", "00000000-0000-4000-8000-000000000001&requestToken=00000000-0000-4000-8000-000000000002"])("rejects malformed or duplicate request tokens: %s", async (query) => {
    const response = await GET(new Request(`http://localhost/api/timers/active?requestToken=${query}`));
    expect(response.status).toBe(400);
    expect(mocks.getActiveTimersForShell).not.toHaveBeenCalled();
  });
  it("binds a timer confirmation to the requesting loader's cache-busting token", async () => {
    const response = await GET(new Request(endpoint));
    expect((await response.json()).data.requestToken).toBe(requestToken);
  });
  it.each(["unauthenticated", "forbidden"])("never confirms a denied %s snapshot", async (code) => {
    mocks.getActiveTimersForShell.mockRejectedValue(new Error(code));
    const response = await GET(new Request(endpoint));
    expect(response.status).toBe(code === "unauthenticated" ? 401 : 403);
    expect(await response.json()).not.toHaveProperty("data.confirmedAt");
  });
  it("confirms the server instant after the loader completes and forbids caching", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
      mocks.getActiveTimersForShell.mockImplementation(async () => {
        vi.setSystemTime(new Date("2026-10-07T12:00:03.000Z"));
        return [];
      });
      const response = await GET(new Request(endpoint));
      expect((await response.json()).data.confirmedAt).toBe("2026-10-07T12:00:03.000Z");
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally { vi.useRealTimers(); }
  });
  it("forwards the selected baby from the query string", async () => {
    mocks.getActiveTimersForShell.mockResolvedValue([{ id: "timer-1" }]);
    const response = await GET(new Request(`${endpoint}&babyId=baby-b`));

    expect(response.status).toBe(200);
    expect(mocks.getActiveTimersForShell).toHaveBeenCalledWith("baby-b");
    expect(await response.json()).toEqual({ ok: true, data: { timers: [{ id: "timer-1" }], confirmedAt: expect.any(String), requestToken } });
  });

  it("requests the explicit all-babies view when no baby is selected", async () => {
    await GET(new Request(endpoint));

    expect(mocks.getActiveTimersForShell).toHaveBeenCalledWith(undefined);
  });

  it.each([
    `${endpoint}&babyId=`,
    `${endpoint}&babyId=&babyId=baby-b`,
    `${endpoint}&babyId=baby-a&babyId=baby-b`
  ])("rejects an invalid or duplicate selected-baby query: %s", async (url) => {
    const response = await GET(new Request(url));

    expect(response.status).toBe(400);
    expect(mocks.getActiveTimersForShell).not.toHaveBeenCalled();
  });
});
