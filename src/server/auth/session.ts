import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth/auth";

export async function getSession() {
  return auth.api.getSession({
    headers: await headers()
  });
}

export async function requireUser() {
  const session = await getSession();
  if (!session?.user) throw new Error("unauthenticated");
  return session.user;
}

export async function requireUserPage() {
  const session = await getSession();
  if (!session?.user) redirect("/login");
  return session.user;
}
