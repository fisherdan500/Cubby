import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth, SESSION_FRESH_AGE_SECONDS } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { captureGlobalSecurityContext } from "@/server/services/global-security";
import { authorizeGlobalSessionSecurity } from "@/server/services/global-session-security";
import {
  REQUIRED_PASSWORD_CHANGE_PATH,
  hasOutstandingRequiredChange
} from "@/server/services/assisted-required-change-state";

/**
 * Per-request memoization, where the runtime provides it.
 *
 * `cache` is exported only under React's `react-server` condition. The real server build resolves it; a
 * plain CommonJS resolution (Vitest, and any non-server consumer) gets `undefined`, and calling that
 * throws at import time and takes every module downstream with it.
 *
 * So it is used when present and skipped when not. Skipping is safe by construction: without memoization
 * every caller resolves the session for itself, which is exactly the behaviour this replaced. The failure
 * mode is a slower request, never a staler session.
 */
const perRequest: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R =
  typeof cache === "function" ? cache : (fn) => fn;

/**
 * The session for THIS request, resolved once however many callers ask.
 *
 * Rendering one `/app` screen asked four times over: the layout's three independent awaits each resolved
 * it for themselves and the page did it again. With `disableCookieCache: true` every one of those is a
 * real round trip that re-runs `authorizeGlobalSessionSecurity`, and they are the bulk of the delay before
 * a navigation can render anything.
 *
 * Memoization is scoped to a single request: nothing is shared between requests or users, and a revoked
 * session is seen by the very next navigation. Deduplicating within a request is also more consistent than
 * not, because four separate lookups could in principle disagree mid-render.
 *
 * Safe to memoize because it only reads: it derives handles with crypto `.update()` calls, then either
 * returns the session or rejects it. Nothing here writes, so no write is skipped by reusing the answer.
 */
export const getSession = perRequest(async () => {
  const session = await auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true }
  });
  if (session?.user?.id && session.session?.id) {
    try {
      await authorizeGlobalSessionSecurity(prisma, { userId: session.user.id, sessionId: session.session.id });
    } catch (error) {
      if (error instanceof Error && error.message === "unauthenticated") return null;
      throw error;
    }
  }
  return session;
});

/**
 * `getSession` is deliberately NOT gated on the assisted first-login obligation: the corridor route
 * and corridor page must stay reachable while an obligation is outstanding, and they authorize
 * themselves through this function. Every helper below that authorizes authority-bearing work gates
 * on it instead, so a corralled identity cannot route around the corridor by calling an API route
 * directly rather than navigating `/app`.
 */
export async function requireUser() {
  const session = await getSession();
  if (!session?.user) throw new Error("unauthenticated");
  if (await hasOutstandingRequiredChange(session.user.id)) throw new Error("password_change_required");
  return session.user;
}

export async function requireGlobalSecurityContext() {
  const session = await getSession();
  if (!session?.user?.id || !session.session?.id) throw new Error("unauthenticated");
  if (await hasOutstandingRequiredChange(session.user.id)) throw new Error("password_change_required");
  return captureGlobalSecurityContext(prisma, { userId: session.user.id, sessionId: session.session.id });
}

export async function requireGlobalSecuritySessionCredential() {
  const session = await getSession();
  if (!session?.user?.id || !session.session?.id || !session.session.token) throw new Error("unauthenticated");
  if (await hasOutstandingRequiredChange(session.user.id)) throw new Error("password_change_required");
  const context = await captureGlobalSecurityContext(prisma, { userId: session.user.id, sessionId: session.session.id });
  return { ...context, sessionToken: session.session.token };
}

export async function clearBetterAuthSessionCookies() {
  const [{ authCookies }, store] = await Promise.all([auth.$context, cookies()]);
  for (const cookie of [authCookies.sessionToken, authCookies.sessionData, authCookies.accountData, authCookies.dontRememberToken]) {
    store.delete(cookie.name);
  }
}

export function assertFreshSession(session: Awaited<ReturnType<typeof getSession>>) {
  if (!session?.user || !session.session) throw new Error("unauthenticated");
  if (Date.now() - new Date(session.session.createdAt).getTime() >= SESSION_FRESH_AGE_SECONDS * 1000) {
    throw new Error("fresh_authentication_required");
  }
  return session;
}

export async function requireFreshSession() {
  const session = assertFreshSession(await getSession());
  if (await hasOutstandingRequiredChange(session.user.id)) throw new Error("password_change_required");
  return session;
}

export async function requireFreshUser() {
  return (await requireFreshSession()).user;
}

export async function requireUserPage() {
  const session = await getSession();
  if (!session?.user) redirect("/login");
  if (await hasOutstandingRequiredChange(session.user.id)) redirect(REQUIRED_PASSWORD_CHANGE_PATH);
  return session.user;
}
