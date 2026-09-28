import { verifyPassword } from "better-auth/crypto";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/server/auth/session";
import {
  captureGlobalSecurityContext,
  changePasswordWithCurrentPassword
} from "@/server/services/global-security";
import {
  REQUIRED_PASSWORD_CHANGE_PATH,
  hasOutstandingRequiredChange
} from "@/server/services/assisted-required-change-state";

export { REQUIRED_PASSWORD_CHANGE_PATH, hasOutstandingRequiredChange };

export type IdentityClassification = "ordinary" | "restricted" | "unauthenticated";

export type ClassifiedIdentity = {
  classification: IdentityClassification;
  userId: string | null;
  sessionId: string | null;
};

/**
 * Fail closed on ANY nonnull obligation. Version equality is deliberately not used: another
 * credential writer (offline recovery) can advance the credential version while the obligation
 * is rebound, and an equality test would silently let that session through as ordinary.
 */
export async function classifyCurrentIdentity(): Promise<ClassifiedIdentity> {
  const session = await getSession();
  const userId = session?.user?.id ?? null;
  const sessionId = session?.session?.id ?? null;
  if (!userId || !sessionId) return { classification: "unauthenticated", userId: null, sessionId: null };
  const restricted = await hasOutstandingRequiredChange(userId);
  return { classification: restricted ? "restricted" : "ordinary", userId, sessionId };
}

type RequiredPasswordChangeSubmission = {
  operationId: string;
  openingFingerprint: string;
  intentFingerprint: string;
  currentPassword: string;
  newPassword: string;
  newPasswordConfirmation: string;
};

const operationIdPattern = /^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;

function parseSubmission(value: unknown): RequiredPasswordChangeSubmission {
  const invalid = () => new Error("required_password_change_request_invalid");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join("|") !== "currentPassword|intentFingerprint|newPassword|newPasswordConfirmation|openingFingerprint|operationId") throw invalid();
  if (typeof input.operationId !== "string" || !operationIdPattern.test(input.operationId)) throw invalid();
  if (typeof input.openingFingerprint !== "string" || !fingerprintPattern.test(input.openingFingerprint)) throw invalid();
  if (typeof input.intentFingerprint !== "string" || !fingerprintPattern.test(input.intentFingerprint)) throw invalid();
  if (typeof input.currentPassword !== "string" || input.currentPassword.length < 1 || input.currentPassword.length > 128) throw invalid();
  if (typeof input.newPassword !== "string" || input.newPassword.length < 8 || input.newPassword.length > 128) throw invalid();
  if (input.newPassword !== input.newPasswordConfirmation) throw invalid();
  return input as RequiredPasswordChangeSubmission;
}

/**
 * Completion runs through the existing canonical self password change. The obligation is cleared
 * by the reviewed deferred database trigger inside that same transaction, never by an app-side
 * setter, so a failed proof or rolled-back transaction leaves the requirement intact.
 */
export async function completeRequiredPasswordChange(raw: unknown) {
  const submission = parseSubmission(raw);
  const session = await getSession();
  const userId = session?.user?.id;
  const sessionId = session?.session?.id;
  if (!userId || !sessionId) throw new Error("unauthenticated");
  if (!(await hasOutstandingRequiredChange(userId))) throw new Error("forbidden");

  const authContext = await auth.$context;
  const account = await prisma.account.findFirst({
    where: { userId, providerId: "credential" },
    select: { password: true }
  });
  if (!account?.password) throw new Error("forbidden");

  // Better Auth's verifier applies the same NFKC normalization as hashing, so this rejects a
  // replacement that is merely a different encoding of the administrator-known password. Use the
  // raw verifier: auth.$context.password.verify is the sign-in proof-capturing wrapper and
  // requires a sign-in request context that does not exist here.
  if (await verifyPassword({ hash: account.password, password: submission.newPassword })) {
    throw new Error("required_password_change_reuse");
  }

  const context = await captureGlobalSecurityContext(prisma, { userId, sessionId });
  const result = await changePasswordWithCurrentPassword(
    prisma,
    context,
    {
      operationId: submission.operationId,
      openingFingerprint: submission.openingFingerprint,
      intentFingerprint: submission.intentFingerprint
    },
    submission.currentPassword,
    submission.newPassword,
    // Raw verifier again: the canonical engine verifies the current password outside any
    // sign-in request, where the proof-capturing wrapper cannot run.
    { verify: verifyPassword },
    { hash: authContext.password.hash }
  );
  return { operationId: result.operationId, status: result.status, signInRequired: true };
}

/**
 * Only the membership recorded by the assisted creation receipt may be selected, and only while
 * it is still an active episode of a live household. There is deliberately no first-membership
 * fallback.
 */
export async function assistedHomeBridgeTarget(userId: string) {
  const state = await prisma.assistedAccountState.findUnique({
    where: { userId },
    select: { requiredChangeCredentialVersion: true, assistedCreationMemberId: true }
  });
  if (state?.requiredChangeCredentialVersion !== null && state?.requiredChangeCredentialVersion !== undefined) {
    return { path: REQUIRED_PASSWORD_CHANGE_PATH, memberId: null };
  }
  const memberId = state?.assistedCreationMemberId ?? null;
  if (!memberId) return { path: "/", memberId: null };
  const member = await prisma.householdMember.findFirst({
    where: { id: memberId, userId, disabledAt: null, deletedAt: null, household: { deletedAt: null } },
    select: { id: true }
  });
  return member ? { path: "/app", memberId: member.id } : { path: "/", memberId: null };
}
