import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn((options) => options),
  prismaAdapter: vi.fn(() => ({})),
  nextCookies: vi.fn(() => ({})),
  initializeGlobalSessionSecurityActivity: vi.fn(),
  assertUserCanStartSession: vi.fn(),
  createPasswordSessionProof: vi.fn(() => ({ credentialProofPurpose: "credential_sign_in" })),
  verifyPasswordAndCaptureSessionProof: vi.fn(),
  verifyPassword: vi.fn(),
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
vi.mock("@/server/auth/password-session-proof", () => ({
  passwordSessionProofAdditionalFields: {
    credentialProofPurpose: { input: false, returned: false, required: false, type: "string" },
    credentialProofHashDigest: { input: false, returned: false, required: false, type: "string" },
    credentialProofIssuedAt: { input: false, returned: false, required: false, type: "date" },
    credentialProofNonce: { input: false, returned: false, required: false, type: "string" },
    credentialProofKeyVersion: { input: false, returned: false, required: false, type: "number" },
    credentialProofMac: { input: false, returned: false, required: false, type: "string" }
  },
  verifyPasswordAndCaptureSessionProof: mocks.verifyPasswordAndCaptureSessionProof,
  createPasswordSessionProof: mocks.createPasswordSessionProof
}));
vi.mock("@better-auth/utils/password", () => ({ verifyPassword: mocks.verifyPassword }));

import { auth } from "@/lib/auth/auth";

beforeEach(() => {
  mocks.createPasswordSessionProof.mockReturnValue({ credentialProofPurpose: "credential_sign_in" });
});

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

  it("keeps the member guard first and preserves the base session fields while attaching private proof", async () => {
    const configured = auth as unknown as {
      databaseHooks: { session: { create: { before: (session: { id: string; userId: string; token: string }) => Promise<{ data: Record<string, unknown> }> } } };
      session: { additionalFields: Record<string, unknown> };
    };
    const session = { id: "session-1", userId: "user-1", token: "token-1" };

    await expect(configured.databaseHooks.session.create.before(session)).resolves.toEqual({
      data: { ...session, credentialProofPurpose: "credential_sign_in" }
    });
    expect(mocks.assertUserCanStartSession).toHaveBeenCalledWith(session);
    expect(Object.keys(configured.session.additionalFields)).toEqual([
      "credentialProofPurpose", "credentialProofHashDigest", "credentialProofIssuedAt",
      "credentialProofNonce", "credentialProofKeyVersion", "credentialProofMac"
    ]);
  });

  it("wraps Better Auth's installed password verifier instead of replacing its algorithm", async () => {
    const configured = auth as unknown as {
      emailAndPassword: { password: { verify: (input: { hash: string; password: string }) => Promise<boolean> } };
    };
    const input = { hash: "stored-hash", password: "plain-password" };
    mocks.verifyPasswordAndCaptureSessionProof.mockResolvedValue(true);

    await expect(configured.emailAndPassword.password.verify(input)).resolves.toBe(true);
    expect(mocks.verifyPasswordAndCaptureSessionProof).toHaveBeenCalledWith(mocks.verifyPassword, input);
  });

  it("attaches no diagnostic logger outside the exact disposable acceptance runtime", () => {
    expect(auth).not.toHaveProperty("logger");
  });

  it("disables Better Auth's built-in limiter so Cubby's layered throttle is authoritative", () => {
    const configured = auth as unknown as { rateLimit: { enabled: boolean } };

    expect(configured.rateLimit.enabled).toBe(false);
  });
});
