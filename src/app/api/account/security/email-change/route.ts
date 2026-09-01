import { randomBytes, randomUUID } from "node:crypto";
import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { clearBetterAuthSessionCookies, requireGlobalSecurityContext, requireGlobalSecuritySessionCredential } from "@/server/auth/session";
import { fail, handleError, ok } from "@/server/http";
import { cancelVerifiedEmailChange, completeVerifiedEmailChange, confirmEmailChangeSuccessorCookieForAuthenticatedSession, emitEmailChangeSuccessorCookie, getVerifiedEmailChangeStatus, initiateVerifiedEmailChange, verifyEmailChangeToken } from "@/server/services/email-change";
import { canonicalizeTrustedClient, configuredGlobalSecurityThrottleKey } from "@/server/services/global-security-throttling";

export const dynamic = "force-dynamic";

const operationIdPattern = /^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;

function assertOperationId(value: unknown) {
  if (typeof value !== "string" || !operationIdPattern.test(value)) throw new Error("email_change_request_invalid");
  return value;
}

function exactKeys(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).sort().join("|") !== [...keys].sort().join("|")) throw new Error("email_change_request_invalid");
}

function metadata(input: Record<string, unknown>) {
  const operationId = assertOperationId(input.operationId);
  if (typeof input.openingFingerprint !== "string" || !fingerprintPattern.test(input.openingFingerprint) || typeof input.intentFingerprint !== "string" || !fingerprintPattern.test(input.intentFingerprint)) throw new Error("email_change_request_invalid");
  return { operationId, openingFingerprint: input.openingFingerprint, intentFingerprint: input.intentFingerprint };
}

function parseRequest(value: unknown):
  | { action: "initiate"; metadata: { operationId: string; openingFingerprint: string; intentFingerprint: string }; currentPassword: string; newEmail: string }
  | { action: "verify"; operationId: string; verification: string }
  | { action: "status" | "cancel" | "cutover" | "confirm"; operationId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("email_change_request_invalid");
  const input = value as Record<string, unknown>;
  if (input.action === "initiate") {
    exactKeys(input, ["action", "operationId", "openingFingerprint", "intentFingerprint", "currentPassword", "newEmail"]);
    if (typeof input.currentPassword !== "string" || input.currentPassword.length < 1 || input.currentPassword.length > 128 || typeof input.newEmail !== "string" || input.newEmail.length < 3 || input.newEmail.length > 320) throw new Error("email_change_request_invalid");
    return { action: "initiate", metadata: metadata(input), currentPassword: input.currentPassword, newEmail: input.newEmail };
  }
  if (input.action === "verify") {
    exactKeys(input, ["action", "operationId", "verification"]);
    if (typeof input.verification !== "string" || input.verification.length < 1 || input.verification.length > 1024 || /:|[?&=/#]/.test(input.verification)) throw new Error("email_change_request_invalid");
    return { action: "verify", operationId: assertOperationId(input.operationId), verification: input.verification };
  }
  if (input.action === "status" || input.action === "cancel" || input.action === "cutover" || input.action === "confirm") {
    exactKeys(input, ["action", "operationId"]);
    return { action: input.action, operationId: assertOperationId(input.operationId) };
  }
  throw new Error("email_change_request_invalid");
}

function emailChangeError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "email_change_request_invalid") return fail(code, "Check the email-change request and try again.", 422);
  if (code === "current_password_invalid") return fail(code, "The current password is incorrect.", 422);
  if (["stale_security_version", "fresh_authentication_required"].includes(code)) return fail("email_change_sign_in_required", "Sign in again before continuing the email change.", 409);
  if (["idempotency_conflict", "email_change_completion_unavailable", "email_change_status_unavailable"].includes(code)) return fail("email_change_status_required", "Check the email-change status before retrying.", 409);
  return handleError(error);
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("email_change_request_invalid");
    let raw: unknown;
    try { raw = await request.json(); } catch { throw new Error("email_change_request_invalid"); }
    const input = parseRequest(raw);
    if (input.action === "initiate") {
      const [context, authContext] = await Promise.all([requireGlobalSecurityContext(), auth.$context]);
      const result = await initiateVerifiedEmailChange(prisma, context, { ...input.metadata, newEmail: input.newEmail }, input.currentPassword, { verifier: { verify: authContext.password.verify }, throttleContext: { key: configuredGlobalSecurityThrottleKey(), client: canonicalizeTrustedClient(env.CUBBY_TRUSTED_PROXY_HOPS, request.headers.get("x-forwarded-for")) } });
      return ok({ operationId: result.operationId, status: result.status });
    }
    if (input.action === "verify") {
      const context = await requireGlobalSecurityContext();
      const result = await verifyEmailChangeToken(prisma, { userId: context.userId, operationId: input.operationId, token: input.verification });
      return ok({ operationId: result.operationId, status: result.status });
    }
    if (input.action === "cancel") {
      const context = await requireGlobalSecurityContext();
      const result = await cancelVerifiedEmailChange(prisma, { userId: context.userId, operationId: input.operationId, sessionId: context.sessionId });
      return ok(result);
    }
    if (input.action === "status") {
      const context = await requireGlobalSecurityContext();
      const result = await getVerifiedEmailChangeStatus(prisma, { userId: context.userId, operationId: input.operationId, sessionId: context.sessionId });
      return ok({ operationId: result.operationId, status: result.status, oldAddressNoticeFailed: result.oldAddressNoticeFailed, cookieState: result.cookieState });
    }
    if (input.action === "confirm") {
      const context = await requireGlobalSecuritySessionCredential();
      const result = await confirmEmailChangeSuccessorCookieForAuthenticatedSession(prisma, context, { operationId: input.operationId });
      return ok(result);
    }
    const context = await requireGlobalSecuritySessionCredential();
    const successorSessionId = randomUUID();
    const successorToken = randomBytes(32).toString("base64url");
    const successorExpiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    const completed = await completeVerifiedEmailChange(prisma, { userId: context.userId, operationId: input.operationId, oldSessionId: context.sessionId, successorSessionId, successorToken, successorExpiresAt });
    if (completed.status !== "completed") return ok({ operationId: completed.operationId, status: completed.status, signInRequired: true });
    const user = await prisma.user.findUnique({ where: { id: context.userId }, select: { id: true, email: true, name: true, image: true, emailVerified: true } });
    if (!user) throw new Error("email_change_completion_unavailable");
    const cookieContext = await auth.$context;
    const emitted = await emitEmailChangeSuccessorCookie(prisma, { userId: context.userId, operationId: input.operationId, successorSessionId, successorToken, cookieContext: cookieContext as never, session: { id: successorSessionId, token: successorToken, userId: context.userId, expiresAt: successorExpiresAt } as never, user: user as never });
    if (emitted.status === "signed_out") await clearBetterAuthSessionCookies();
    return ok({ operationId: emitted.operationId, status: emitted.status, signInRequired: emitted.status === "signed_out" });
  } catch (error) {
    return emailChangeError(error);
  }
}
