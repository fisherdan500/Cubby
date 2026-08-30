import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  cookies: vi.fn(),
  deleteCookie: vi.fn(),
  getSession: vi.fn(),
  captureGlobalSecurityContext: vi.fn(),
  authorizeGlobalSessionSecurity: vi.fn()
}));

vi.mock("next/headers", () => ({ headers: mocks.headers, cookies: mocks.cookies }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/auth", () => ({
  auth: {
    api: { getSession: mocks.getSession },
    $context: Promise.resolve({ authCookies: {
      sessionToken: { name: "better-auth.session_token" },
      sessionData: { name: "better-auth.session_data" },
      accountData: { name: "better-auth.account_data" },
      dontRememberToken: { name: "better-auth.dont_remember" }
    } })
  },
  SESSION_FRESH_AGE_SECONDS: 60 * 10
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/services/global-security", () => ({ captureGlobalSecurityContext: mocks.captureGlobalSecurityContext }));
vi.mock("@/server/services/global-session-security", () => ({ authorizeGlobalSessionSecurity: mocks.authorizeGlobalSessionSecurity }));

import { assertFreshSession, clearBetterAuthSessionCookies, getSession, requireFreshSession, requireFreshUser, requireGlobalSecurityContext, requireGlobalSecuritySessionCredential } from "@/server/auth/session";

describe("server session lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers({ cookie: "session=value" }));
    mocks.getSession.mockResolvedValue(null);
    mocks.authorizeGlobalSessionSecurity.mockResolvedValue(undefined);
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

  it("reauthorizes every authenticated lookup against the database-clock session procedure", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" }, session: { id: "session-1" } });

    await expect(getSession()).resolves.toEqual({ user: { id: "user-1" }, session: { id: "session-1" } });

    expect(mocks.authorizeGlobalSessionSecurity).toHaveBeenCalledWith({}, { userId: "user-1", sessionId: "session-1" });
  });


  it("turns a database lifetime denial into an anonymous session for optional server probes", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" }, session: { id: "session-1" } });
    mocks.authorizeGlobalSessionSecurity.mockRejectedValue(new Error("unauthenticated"));

    await expect(getSession()).resolves.toBeNull();
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

  it("captures global security context only from the cache-bypassing authenticated user and session IDs", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" }, session: { id: "session-1" } });
    mocks.captureGlobalSecurityContext.mockResolvedValue({ userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 });

    await expect(requireGlobalSecurityContext()).resolves.toEqual({ userId: "user-1", sessionId: "session-1", credentialVersion: 1, sessionSecurityVersion: 1 });
    expect(mocks.captureGlobalSecurityContext).toHaveBeenCalledWith({}, { userId: "user-1", sessionId: "session-1" });
  });

  it("derives the successor confirmation credential from the authenticated HttpOnly session", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" }, session: { id: "session-1", token: "authoritative-token" } });
    mocks.captureGlobalSecurityContext.mockResolvedValue({ userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3 });

    await expect(requireGlobalSecuritySessionCredential()).resolves.toEqual({ userId: "user-1", sessionId: "session-1", credentialVersion: 2, sessionSecurityVersion: 3, sessionToken: "authoritative-token" });
  });

  it("rejects missing authenticated user or session identity before global security capture", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" }, session: null });

    await expect(requireGlobalSecurityContext()).rejects.toThrow("unauthenticated");
    expect(mocks.captureGlobalSecurityContext).not.toHaveBeenCalled();
  });

  it("clears every configured Better Auth session and cache cookie", async () => {
    mocks.cookies.mockResolvedValue({ delete: mocks.deleteCookie });

    await clearBetterAuthSessionCookies();

    expect(mocks.deleteCookie.mock.calls.map(([name]) => name)).toEqual([
      "better-auth.session_token",
      "better-auth.session_data",
      "better-auth.account_data",
      "better-auth.dont_remember"
    ]);
  });
});
