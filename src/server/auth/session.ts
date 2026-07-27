import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth, SESSION_FRESH_AGE_SECONDS } from "@/lib/auth/auth";

export async function getSession() {
  return auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true }
  });
}

export async function requireUser() {
  const session = await getSession();
  if (!session?.user) throw new Error("unauthenticated");
  return session.user;
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
