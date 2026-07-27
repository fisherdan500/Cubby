import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  getSession: vi.fn()
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
  SESSION_FRESH_AGE_SECONDS: 60 * 10
}));

import { assertFreshSession, getSession, requireFreshSession, requireFreshUser } from "@/server/auth/session";

describe("server session lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers({ cookie: "session=value" }));
    mocks.getSession.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bypasses the cookie cache so revoked database sessions stop immediately", async () => {
    await getSession();

    expect(mocks.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      query: { disableCookieCache: true }
    });
  });

  it("rejects a user whose session is older than the configured freshness window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1" },
      session: { createdAt: new Date("2026-07-27T11:50:00.000Z") }
    });

    await expect(requireFreshUser()).rejects.toThrow("fresh_authentication_required");
  });

  it("revalidates already-read freshness evidence without another session lookup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    mocks.getSession.mockResolvedValue({
      user: { id: "user-1" },
      session: { createdAt: new Date("2026-07-27T11:50:01.000Z") }
    });
    const freshSession = await requireFreshSession();
    vi.setSystemTime(new Date("2026-07-27T12:00:02.000Z"));

    expect(() => assertFreshSession(freshSession)).toThrow("fresh_authentication_required");
    expect(mocks.getSession).toHaveBeenCalledOnce();
  });
});
