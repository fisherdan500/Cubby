import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { clearBetterAuthSessionCookies } from "@/server/auth/session";
import { fail, handleError, ok } from "@/server/http";
import { recoverPasswordWithCode } from "@/server/services/recovery-lifecycle";
import { performNeutralRecoveryCodeVerification } from "@/server/services/recovery-codes";
import { canonicalizeTrustedClient, configuredGlobalSecurityThrottleKey, precheckGlobalSecurityThrottle, recordGlobalSecurityThrottleFailure } from "@/server/services/global-security-throttling";

export const dynamic = "force-dynamic";

const operationIdPattern = /^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;

type RecoveryResetRequest = { email: string; code: string; newPassword: string; operationId: string; openingFingerprint: string; intentFingerprint: string };

function parseRequest(value: unknown): RecoveryResetRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recovery_reset_request_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join("|") !== "code|email|intentFingerprint|newPassword|openingFingerprint|operationId") throw new Error("recovery_reset_request_invalid");
  if (typeof input.email !== "string" || input.email.length < 3 || input.email.length > 320 || typeof input.code !== "string" || input.code.length < 1 || input.code.length > 128 || typeof input.newPassword !== "string" || input.newPassword.length < 8 || input.newPassword.length > 128 || typeof input.operationId !== "string" || !operationIdPattern.test(input.operationId) || typeof input.openingFingerprint !== "string" || !fingerprintPattern.test(input.openingFingerprint) || typeof input.intentFingerprint !== "string" || !fingerprintPattern.test(input.intentFingerprint)) throw new Error("recovery_reset_request_invalid");
  return input as RecoveryResetRequest;
}

function neutralRecoveryResponse() {
  return ok({ status: "submitted", signInRequired: true }, { status: 202 });
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("recovery_reset_request_invalid");
    let raw: unknown;
    try { raw = await request.json(); } catch { throw new Error("recovery_reset_request_invalid"); }
    const input = parseRequest(raw);
    const users = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "User"
      WHERE "normalize_security_email_v1"("email")="normalize_security_email_v1"(${input.email})
      LIMIT 1
    `;
    const userId = users[0]?.id;
    const accountNeutralThrottle = { key: configuredGlobalSecurityThrottleKey(), client: canonicalizeTrustedClient(env.CUBBY_TRUSTED_PROXY_HOPS, request.headers.get("x-forwarded-for")) };
    const state = await prisma.accountSecurityState.findUnique({ where: { userId: userId ?? "cubby-absent-recovery-user" }, select: { credentialVersion: true, sessionSecurityVersion: true } });
    if (!userId || !state) {
      const authContext = await auth.$context;
      await authContext.password.hash(input.newPassword);
      await precheckGlobalSecurityThrottle(prisma, accountNeutralThrottle);
      await performNeutralRecoveryCodeVerification(input.code);
      await recordGlobalSecurityThrottleFailure(prisma, accountNeutralThrottle);
      return neutralRecoveryResponse();
    }
    const authContext = await auth.$context;
    await recoverPasswordWithCode(
      prisma,
      { userId, operationId: input.operationId, openingFingerprint: input.openingFingerprint, intentFingerprint: input.intentFingerprint, code: input.code, credentialVersion: state.credentialVersion, sessionSecurityVersion: state.sessionSecurityVersion },
      input.newPassword,
      { hash: authContext.password.hash },
      undefined,
      undefined,
      accountNeutralThrottle
    );
    await clearBetterAuthSessionCookies();
    return neutralRecoveryResponse();
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "recovery_reset_request_invalid") return fail(code, "Check the recovery request and try again.", 422);
    if (["recovery_code_invalid", "recovery_session_expired", "recovery_reset_authorization_required", "stale_security_version", "idempotency_conflict", "operation_outcome_unknown"].includes(code)) return neutralRecoveryResponse();
    return handleError(error);
  }
}
