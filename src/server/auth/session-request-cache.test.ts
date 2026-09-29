// @vitest-environment node
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Every server-rendered /app screen validates the session against the database FOUR times on a single
// navigation, because three independent layout awaits each resolve it for themselves and the page does it
// once more:
//
//   requireUserPage()                -> getSession()
//   requireInvitationSetupCorridor() -> currentInvitationSetupCorridor() -> getSession()
//   getHouseholdSelectionState()     -> requireUser() -> getSession()
//   the page itself                  -> requireUserPage() -> getSession()
//
// getSession passes `disableCookieCache: true`, so each one is a real round trip, and authorizeGlobal-
// SessionSecurity runs again every time. Nothing about it is a write: it derives handles with crypto
// .update() calls and either returns or throws. So within ONE request the answer cannot change, and
// resolving it once is both faster and more consistent -- four separate lookups could in principle
// disagree mid-render if a session were revoked between them.
//
// React's `cache` scopes memoization to a single request, so this shares nothing between users or
// requests. That property is what makes it safe here, and is the thing worth pinning.

const source = readFileSync("src/server/auth/session.ts", "utf8");

it("resolves the session once per request, not once per caller", () => {
  expect(source).toMatch(/import \{ cache \} from "react"/);
  // The memoized wrapper must be what callers reach, so the export itself is wrapped.
  expect(source).toMatch(/export const getSession = perRequest\(/);
});

it("survives a runtime that does not export cache, instead of throwing at import", () => {
  // React exports `cache` only under its react-server condition. Calling an undefined import throws
  // during module evaluation and takes every downstream module with it -- which is exactly how this
  // first landed, breaking 32 test files at collection time. Absence must degrade, not explode.
  expect(source).toMatch(/typeof cache === "function" \? cache : \(fn\) => fn/);
});

it("keeps the database check inside the memoized call, not outside it", () => {
  // Memoizing only the cookie read while leaving authorizeGlobalSessionSecurity to run per caller would
  // keep the round trips this exists to remove.
  expect(source).toMatch(/export const getSession = perRequest\(async \(\) => \{[\s\S]{0,900}authorizeGlobalSessionSecurity/);
});

it("still returns null for a session the security check rejects", () => {
  // The unauthenticated path must stay a null return rather than a throw, because callers distinguish
  // "no session" (redirect to login) from a real fault (500).
  expect(source).toMatch(/message === "unauthenticated"\) return null/);
});

it("does not memoize the obligation check, which a caller may need fresh", () => {
  // hasOutstandingRequiredChange gates the assisted first-login corridor. It is deliberately left
  // un-memoized: it is consulted after a password change within the same request in some flows.
  expect(source).not.toMatch(/const hasOutstandingRequiredChange = cache\(/);
});
