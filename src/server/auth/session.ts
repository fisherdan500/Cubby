import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, SESSION_FRESH_AGE_SECONDS } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { captureGlobalSecurityContext } from "@/server/services/global-security";
import { authorizeGlobalSessionSecurity } from "@/server/services/global-session-security";

export async function getSession() {
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
}

export async function requireUser() {
  const session = await getSession();
  if (!session?.user) throw new Error("unauthenticated");
  return session.user;
}

export async function requireGlobalSecurityContext() {
  const session = await getSession();
  if (!session?.user?.id || !session.session?.id) throw new Error("unauthenticated");
  return captureGlobalSecurityContext(prisma, { userId: session.user.id, sessionId: session.session.id });
}

export async function requireGlobalSecuritySessionCredential() {
  const session = await getSession();
  if (!session?.user?.id || !session.session?.id || !session.session.token) throw new Error("unauthenticated");
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
  return assertFreshSession(await getSession());
}

export async function requireFreshUser() {
  return (await requireFreshSession()).user;
}

export async function requireUserPage() {
  const session = await getSession();
  if (!session?.user) redirect("/login");
  return session.user;
}
