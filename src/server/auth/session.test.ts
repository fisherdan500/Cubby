import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  getSession: vi.fn()
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));

import { getSession } from "@/server/auth/session";

describe("server session lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers({ cookie: "session=value" }));
    mocks.getSession.mockResolvedValue(null);
  });

  it("bypasses the cookie cache so revoked database sessions stop immediately", async () => {
    await getSession();

    expect(mocks.getSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      query: { disableCookieCache: true }
    });
  });
});
