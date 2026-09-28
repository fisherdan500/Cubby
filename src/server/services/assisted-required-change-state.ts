import { prisma } from "@/lib/db/prisma";

/**
 * The corridor lives outside `/app` because `/app` is exactly the subtree an outstanding
 * obligation must not reach.
 */
export const REQUIRED_PASSWORD_CHANGE_PATH = "/account/required-password-change";

/**
 * Fail closed on ANY nonnull obligation. Version equality is deliberately not used: another
 * credential writer (offline recovery) can advance the credential version while the obligation
 * is rebound, and an equality test would silently let that session through as ordinary.
 *
 * This module intentionally depends only on Prisma so the session gate can import it without a
 * cycle.
 */
export async function hasOutstandingRequiredChange(userId: string) {
  const state = await prisma.assistedAccountState.findUnique({
    where: { userId },
    select: { requiredChangeCredentialVersion: true }
  });
  return state?.requiredChangeCredentialVersion !== null && state?.requiredChangeCredentialVersion !== undefined;
}
