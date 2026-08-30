import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn((options) => options),
  prismaAdapter: vi.fn(() => ({})),
  nextCookies: vi.fn(() => ({})),
  initializeGlobalSessionSecurityActivity: vi.fn(),
  assertUserCanStartSession: vi.fn(),
  prisma: { connection: "runtime" },
  authPrisma: { connection: "auth" }
}));

vi.mock("better-auth", () => ({ betterAuth: mocks.betterAuth }));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: mocks.prismaAdapter }));
vi.mock("better-auth/next-js", () => ({ nextCookies: mocks.nextCookies }));
vi.mock("@/lib/db/prisma", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/db/auth-prisma", () => ({ authPrisma: mocks.authPrisma }));
vi.mock("@/lib/env", () => ({ env: { BETTER_AUTH_SECRET: "test-secret", BETTER_AUTH_URL: "http://localhost:3000" }, trustedOrigins: () => ["http://localhost:3000"] }));
vi.mock("@/server/auth/member-status", () => ({ assertUserCanStartSession: mocks.assertUserCanStartSession }));
vi.mock("@/server/auth/session-adapter", () => ({ withSuspendedSessionErrorTranslation: (adapter: unknown) => adapter }));
vi.mock("@/server/services/global-session-security", () => ({ initializeGlobalSessionSecurityActivity: mocks.initializeGlobalSessionSecurityActivity }));

import { auth } from "@/lib/auth/auth";

describe("Better Auth session security configuration", () => {
  it("uses the isolated auth Prisma connection for the Better Auth adapter while keeping session-security hooks on the runtime client", () => {
    expect(mocks.prismaAdapter).toHaveBeenCalledWith(mocks.authPrisma, { provider: "postgresql" });
  });

  it("initializes exactly one activity record after every ordinary session creation and disables cookie caching", async () => {
    const configured = auth as unknown as {
      databaseHooks: { session: { create: { after: (session: { id: string; userId: string }) => Promise<void> } } };
      session: { cookieCache: { enabled: boolean } };
    };

    await configured.databaseHooks.session.create.after({ id: "session-1", userId: "user-1" });

    expect(mocks.initializeGlobalSessionSecurityActivity).toHaveBeenCalledWith(mocks.prisma, { userId: "user-1", sessionId: "session-1" });
    expect(configured.session.cookieCache.enabled).toBe(false);
  });

  it("disables Better Auth's built-in limiter so Cubby's layered throttle is authoritative", () => {
    const configured = auth as unknown as { rateLimit: { enabled: boolean } };

    expect(configured.rateLimit.enabled).toBe(false);
  });
});
