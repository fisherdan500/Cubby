import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter, type MemoryDB } from "better-auth/adapters/memory";
import { hashPassword } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { p13SeededFixtureEmail } from "../../../scripts/p1-3-invitation-browser-fixture-identity";
import {
  observeBetterAuthSignInRejectionLog,
  runWithBetterAuthSignInRejectionScope,
  takeBetterAuthSignInRejection
} from "@/server/auth/acceptance-sign-in-rejection";

// Runs a user seeded exactly like the P1-3 existing-recipient browser fixture through Better Auth's real
// email sign-in and default password verifier, with an in-memory database instead of PostgreSQL.
async function seededAuth(suffix = randomBytes(8).toString("hex")) {
  const userId = `p13_browser_existing_${suffix}`;
  const email = p13SeededFixtureEmail("existing", suffix);
  const password = `P13-${randomBytes(24).toString("base64url")}`;
  const now = new Date();
  const db: MemoryDB = {
    user: [{ id: userId, name: `Existing recipient ${suffix}`, email, emailVerified: true, image: null, createdAt: now, updatedAt: now }],
    account: [{ id: `p13_browser_existing_account_${suffix}`, accountId: userId, providerId: "credential", userId, password: await hashPassword(password), createdAt: now, updatedAt: now }],
    session: [],
    verification: []
  };
  const auth = betterAuth({
    database: memoryAdapter(db),
    secret: randomBytes(32).toString("base64url"),
    baseURL: "http://localhost:3000",
    rateLimit: { enabled: false },
    emailAndPassword: { enabled: true, revokeSessionsOnPasswordReset: true },
    session: { cookieCache: { enabled: false } },
    logger: { level: "warn", log: observeBetterAuthSignInRejectionLog }
  });
  return { auth, db, userId, email, password };
}

async function rejectionCode(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    return (error as { body?: { code?: unknown } }).body?.code;
  }
  return "accepted";
}

describe("fixture-seeded credential sign-in through real Better Auth", () => {
  it("accepts the fixture-style existing recipient and creates exactly one session for that user", () => runWithBetterAuthSignInRejectionScope(async () => {
    const { auth, db, userId, email, password } = await seededAuth();
    takeBetterAuthSignInRejection();

    const result = await auth.api.signInEmail({ body: { email, password, rememberMe: true, callbackURL: "/invite/dispatch" } });

    expect(result.user.id).toBe(userId);
    expect(db.session).toHaveLength(1);
    expect(db.session[0]?.userId).toBe(userId);
    expect(takeBetterAuthSignInRejection()).toBeUndefined();
  }));

  it("signs in a fixture recipient whose base64url suffix contains uppercase characters", () => runWithBetterAuthSignInRejectionScope(async () => {
    // The browser fixture suffix is base64url, so it routinely contains uppercase letters.
    const { auth, db, userId, email, password } = await seededAuth(`Qz${randomBytes(18).toString("base64url")}`);
    takeBetterAuthSignInRejection();

    const result = await auth.api.signInEmail({ body: { email, password, rememberMe: true, callbackURL: "/invite/dispatch" } });

    expect(result.user.id).toBe(userId);
    expect(db.session).toHaveLength(1);
    expect(takeBetterAuthSignInRejection()).toBeUndefined();
  }));

  it("maps Better Auth's real rejection warnings to the fixed acceptance categories", () => runWithBetterAuthSignInRejectionScope(async () => {
    const { auth, db, email, password } = await seededAuth();
    takeBetterAuthSignInRejection();

    await expect(rejectionCode(auth.api.signInEmail({ body: { email, password: `${password}x` } }))).resolves.toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(takeBetterAuthSignInRejection()).toBe("password-mismatch");

    await expect(rejectionCode(auth.api.signInEmail({ body: { email: `absent-${email}`, password } }))).resolves.toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(takeBetterAuthSignInRejection()).toBe("user-not-found");

    const account = db.account[0]!;
    account.password = null;
    await expect(rejectionCode(auth.api.signInEmail({ body: { email, password } }))).resolves.toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(takeBetterAuthSignInRejection()).toBe("password-not-found");

    account.providerId = "not-credential";
    await expect(rejectionCode(auth.api.signInEmail({ body: { email, password } }))).resolves.toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(takeBetterAuthSignInRejection()).toBe("credential-account-not-found");
    expect(db.session).toHaveLength(0);
  }));
});
