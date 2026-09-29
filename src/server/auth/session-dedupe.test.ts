// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The point of the wrapper is that ONE request resolves the session once. A fallback that silently
// declines to memoize would still pass a source check, so this exercises the real behaviour: with a
// working `cache` the underlying lookup must happen once for many callers, and the security check with it.

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  authorize: vi.fn(),
  headers: vi.fn()
}));

vi.mock("next/headers", () => ({ headers: mocks.headers, cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/auth", () => ({
  auth: { api: { getSession: mocks.getSession }, $context: Promise.resolve({}) },
  SESSION_FRESH_AGE_SECONDS: 900
}));
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/server/services/global-security", () => ({ captureGlobalSecurityContext: vi.fn() }));
vi.mock("@/server/services/global-session-security", () => ({ authorizeGlobalSessionSecurity: mocks.authorize }));
vi.mock("@/server/services/assisted-required-change-state", () => ({
  REQUIRED_PASSWORD_CHANGE_PATH: "/account/required-password-change",
  hasOutstandingRequiredChange: vi.fn().mockResolvedValue(false)
}));

// React 18's CJS entry has no `cache`, which is the whole reason the wrapper is conditional. Supplying a
// faithful per-scope implementation here proves the wrapper USES it when the real server build provides it.
vi.mock("react", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react");
  return {
    ...actual,
    cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
      let called = false;
      let value: R;
      return (...args: A): R => {
        if (!called) {
          called = true;
          value = fn(...args);
        }
        return value;
      };
    }
  };
});

beforeEach(() => {
  mocks.headers.mockResolvedValue(new Headers());
  mocks.getSession.mockResolvedValue({ user: { id: "user-1" }, session: { id: "session-1" } });
  mocks.authorize.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("session resolution within one request", () => {
  it("hits the database once however many callers ask", async () => {
    const { getSession, requireUser } = await import("@/server/auth/session");

    // Four callers, mirroring what one /app navigation actually did: three layout awaits and the page.
    await getSession();
    await getSession();
    await requireUser();
    await requireUser();

    expect(mocks.getSession).toHaveBeenCalledTimes(1);
    // And the global session-security check, which is the expensive half, runs once too.
    expect(mocks.authorize).toHaveBeenCalledTimes(1);
  });

  it("still rejects a session the security check refuses", async () => {
    vi.resetModules();
    mocks.authorize.mockRejectedValue(new Error("unauthenticated"));
    const { getSession } = await import("@/server/auth/session");

    // Memoizing must not turn a refusal into a pass: the refused result is what gets reused.
    await expect(getSession()).resolves.toBeNull();
    await expect(getSession()).resolves.toBeNull();
  });
});
