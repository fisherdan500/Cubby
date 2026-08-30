import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { clearBetterAuthSessionCookies, requireGlobalSecurityContext } from "@/server/auth/session";
import { fail, handleError, ok } from "@/server/http";
import { recordQualifyingGlobalSessionUseAfterSuccess, revokeGlobalSessionSecurityWithCurrentPassword, type SessionRevokeScope } from "@/server/services/global-session-security";
import { canonicalizeTrustedClient, configuredGlobalSecurityThrottleKey } from "@/server/services/global-security-throttling";

export const dynamic = "force-dynamic";

type RevokeRequest = {
  operationId: string;
  openingFingerprint: string;
  intentFingerprint: string;
  scope: SessionRevokeScope;
  targetHandle?: string;
  confirmed: boolean;
  currentPassword: string;
};

const operationIdPattern = /^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;
const handlePattern = /^[A-Za-z0-9_-]{30}$/;

function parseRevokeRequest(value: unknown): RevokeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session_revoke_request_invalid");
  const input = value as Record<string, unknown>;
  const scope = input.scope;
  if (scope !== "current" && scope !== "one" && scope !== "others" && scope !== "all") throw new Error("session_revoke_request_invalid");
  const expectedKeys = new Set([
    "operationId", "openingFingerprint", "intentFingerprint", "scope", "confirmed", "currentPassword",
    ...(scope === "current" || scope === "one" ? ["targetHandle"] : [])
  ]);
  if (Object.keys(input).length !== expectedKeys.size || Object.keys(input).some((key) => !expectedKeys.has(key))) throw new Error("session_revoke_request_invalid");
  if (typeof input.operationId !== "string" || !operationIdPattern.test(input.operationId)) throw new Error("session_revoke_request_invalid");
  if (typeof input.openingFingerprint !== "string" || !fingerprintPattern.test(input.openingFingerprint)) throw new Error("session_revoke_request_invalid");
  if (typeof input.intentFingerprint !== "string" || !fingerprintPattern.test(input.intentFingerprint)) throw new Error("session_revoke_request_invalid");
  if (input.confirmed !== true) throw new Error("session_revoke_request_invalid");
  if (typeof input.currentPassword !== "string" || input.currentPassword.length < 1 || input.currentPassword.length > 128) throw new Error("session_revoke_request_invalid");
  if ((scope === "current" || scope === "one") && (typeof input.targetHandle !== "string" || !handlePattern.test(input.targetHandle))) throw new Error("session_revoke_request_invalid");
  return input as RevokeRequest;
}

function revokeError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "session_revoke_request_invalid") return fail(code, "Check the session revocation request and try again.", 422);
  if (code === "current_password_invalid") return fail(code, "The current password is incorrect.", 422);
  if (code === "stale_security_version") return fail("session_revoke_stale", "Your security state changed. Sign in again before retrying.", 409);
  if (code === "idempotency_conflict") return fail("session_revoke_conflict", "This revocation request no longer matches its original action.", 409);
  if (code === "operation_outcome_unknown") return fail("session_revoke_status_required", "Check the authoritative revocation status before retrying.", 409);
  return handleError(error);
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("session_revoke_request_invalid");
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      throw new Error("session_revoke_request_invalid");
    }
    const input = parseRevokeRequest(value);
    const context = await requireGlobalSecurityContext();
    const authContext = await auth.$context;
    const result = await revokeGlobalSessionSecurityWithCurrentPassword(
      prisma,
      context,
      {
        operationId: input.operationId,
        openingFingerprint: input.openingFingerprint,
        intentFingerprint: input.intentFingerprint,
        scope: input.scope,
        ...(input.targetHandle === undefined ? {} : { targetHandle: input.targetHandle }),
        confirmed: input.confirmed
      },
      input.currentPassword,
      { verify: authContext.password.verify },
      undefined,
      { key: configuredGlobalSecurityThrottleKey(), client: canonicalizeTrustedClient(env.CUBBY_TRUSTED_PROXY_HOPS, request.headers.get("x-forwarded-for")) }
    );
    const signedOut = input.scope === "current" || input.scope === "all";
    if (!signedOut) await recordQualifyingGlobalSessionUseAfterSuccess(prisma, context, "private_security_action");
    if (signedOut) await clearBetterAuthSessionCookies();
    return ok({ ...result, signedOut });
  } catch (error) {
    return revokeError(error);
  }
}
