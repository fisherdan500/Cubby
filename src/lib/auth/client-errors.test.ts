import { describe, expect, it } from "vitest";
import { authFailureMessage, isSessionReauthenticationRequired } from "@/lib/auth/client-errors";

describe("auth client errors", () => {
  it("recognizes Better Auth's stale-session response", () => {
    expect(isSessionReauthenticationRequired({ status: 403, code: "SESSION_NOT_FRESH" })).toBe(true);
    expect(isSessionReauthenticationRequired({ status: 500, message: "Server error" })).toBe(false);
  });

  it("explains the production sign-in throttle", () => {
    expect(authFailureMessage("login", { status: 429, message: "Too many requests." })).toBe(
      "Too many sign-in requests. Wait 10 seconds and try again."
    );
  });

  it("keeps ordinary sign-in failures generic", () => {
    expect(authFailureMessage("login", { status: 401, message: "Provider disclosed an account-specific failure." })).toBe(
      "Unable to sign in right now. Try again."
    );
  });
});
