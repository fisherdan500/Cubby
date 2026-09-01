import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { clearBetterAuthSessionCookies, requireGlobalSecurityContext } from "@/server/auth/session";
import { fail, handleError, ok } from "@/server/http";
import { changePasswordWithCurrentPassword } from "@/server/services/global-security";
import { canonicalizeTrustedClient, configuredGlobalSecurityThrottleKey } from "@/server/services/global-security-throttling";

export const dynamic = "force-dynamic";

type PasswordChangeRequest = {
  operationId: string;
  openingFingerprint: string;
  intentFingerprint: string;
  currentPassword: string;
  newPassword: string;
};

const operationIdPattern = /^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;

function parseRequest(value: unknown): PasswordChangeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("password_change_request_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join("|") !== "currentPassword|intentFingerprint|newPassword|openingFingerprint|operationId") throw new Error("password_change_request_invalid");
  if (typeof input.operationId !== "string" || !operationIdPattern.test(input.operationId)) throw new Error("password_change_request_invalid");
  if (typeof input.openingFingerprint !== "string" || !fingerprintPattern.test(input.openingFingerprint)) throw new Error("password_change_request_invalid");
  if (typeof input.intentFingerprint !== "string" || !fingerprintPattern.test(input.intentFingerprint)) throw new Error("password_change_request_invalid");
  if (typeof input.currentPassword !== "string" || input.currentPassword.length < 1 || input.currentPassword.length > 128) throw new Error("password_change_request_invalid");
  if (typeof input.newPassword !== "string" || input.newPassword.length < 8 || input.newPassword.length > 128) throw new Error("password_change_request_invalid");
  return input as PasswordChangeRequest;
}

function passwordChangeError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "password_change_request_invalid") return fail(code, "Check the password change request and try again.", 422);
  if (code === "current_password_invalid") return fail(code, "The current password is incorrect.", 422);
  if (code === "fresh_authentication_required" || code === "stale_security_version") return fail("password_change_sign_in_required", "Sign in again before changing your password.", 409);
  if (code === "idempotency_conflict") return fail("password_change_conflict", "This password change no longer matches its original request.", 409);
  if (code === "operation_outcome_unknown") return fail("password_change_status_required", "Check the password change status before retrying.", 409);
  return handleError(error);
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("password_change_request_invalid");
    let raw: unknown;
    try { raw = await request.json(); } catch { throw new Error("password_change_request_invalid"); }
    const input = parseRequest(raw);
    const [context, authContext] = await Promise.all([requireGlobalSecurityContext(), auth.$context]);
    const result = await changePasswordWithCurrentPassword(
      prisma,
      context,
      input,
      input.currentPassword,
      input.newPassword,
      { verify: authContext.password.verify },
      { hash: authContext.password.hash },
      undefined,
      { key: configuredGlobalSecurityThrottleKey(), client: canonicalizeTrustedClient(env.CUBBY_TRUSTED_PROXY_HOPS, request.headers.get("x-forwarded-for")) }
    );
    await clearBetterAuthSessionCookies();
    return ok({ operationId: result.operationId, status: result.status, signInRequired: true });
  } catch (error) {
    return passwordChangeError(error);
  }
}
