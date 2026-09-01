import { auth } from "@/lib/auth/auth";
import { prisma } from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { requireGlobalSecurityContext } from "@/server/auth/session";
import { fail, handleError, ok } from "@/server/http";
import { issueFreshAuthGrantForCurrentPassword } from "@/server/services/global-security";
import { canonicalizeTrustedClient, configuredGlobalSecurityThrottleKey } from "@/server/services/global-security-throttling";
import { acknowledgeRecoveryCodeSetSaved, getRecoveryEnrollmentStatus, issueRecoveryCodeSet, rehearseRecoveryCodeSet } from "@/server/services/recovery-lifecycle";

export const dynamic = "force-dynamic";

const operationIdPattern = /^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;
type EnrollmentMetadata = { operationId: string; openingFingerprint: string; intentFingerprint: string };

function enrollmentMetadata(input: Record<string, unknown>): EnrollmentMetadata {
  if (typeof input.operationId !== "string" || !operationIdPattern.test(input.operationId) || typeof input.openingFingerprint !== "string" || !fingerprintPattern.test(input.openingFingerprint) || typeof input.intentFingerprint !== "string" || !fingerprintPattern.test(input.intentFingerprint)) throw new Error("recovery_request_invalid");
  return { operationId: input.operationId, openingFingerprint: input.openingFingerprint, intentFingerprint: input.intentFingerprint };
}

function setVersion(value: unknown) {
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1 || value > 2_147_483_647) throw new Error("recovery_request_invalid");
  return value;
}

function exactKeys(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).sort().join("|") !== [...keys].sort().join("|")) throw new Error("recovery_request_invalid");
}

function parseRequest(value: unknown):
  | { action: "enroll" | "regenerate"; metadata: EnrollmentMetadata; currentPassword: string }
  | { action: "acknowledge"; operationId: string; setVersion: number }
  | { action: "rehearse"; metadata: EnrollmentMetadata; setVersion: number; code: string }
  | { action: "status"; metadata: EnrollmentMetadata } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recovery_request_invalid");
  const input = value as Record<string, unknown>;
  if (input.action === "enroll" || input.action === "regenerate") {
    exactKeys(input, ["action", "operationId", "openingFingerprint", "intentFingerprint", "currentPassword"]);
    if (typeof input.currentPassword !== "string" || input.currentPassword.length < 1 || input.currentPassword.length > 128) throw new Error("recovery_request_invalid");
    return { action: input.action, metadata: enrollmentMetadata(input), currentPassword: input.currentPassword };
  }
  if (input.action === "acknowledge") {
    exactKeys(input, ["action", "operationId", "setVersion"]);
    if (typeof input.operationId !== "string" || !operationIdPattern.test(input.operationId)) throw new Error("recovery_request_invalid");
    return { action: "acknowledge", operationId: input.operationId, setVersion: setVersion(input.setVersion) };
  }
  if (input.action === "rehearse") {
    exactKeys(input, ["action", "operationId", "openingFingerprint", "intentFingerprint", "setVersion", "code"]);
    if (typeof input.code !== "string" || input.code.length < 1 || input.code.length > 128) throw new Error("recovery_request_invalid");
    return { action: "rehearse", metadata: enrollmentMetadata(input), setVersion: setVersion(input.setVersion), code: input.code };
  }
  if (input.action === "status") {
    exactKeys(input, ["action", "operationId", "openingFingerprint", "intentFingerprint"]);
    return { action: "status", metadata: enrollmentMetadata(input) };
  }
  throw new Error("recovery_request_invalid");
}

function recoveryError(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (code === "recovery_request_invalid") return fail(code, "Check the recovery request and try again.", 422);
  if (code === "current_password_invalid" || code === "recovery_code_invalid") return fail(code, "That proof could not be accepted. Try again.", 422);
  if (["fresh_authentication_required", "stale_security_version"].includes(code)) return fail("recovery_sign_in_required", "Sign in again before continuing recovery setup.", 409);
  if (["idempotency_conflict", "operation_outcome_unknown"].includes(code)) return fail("recovery_status_required", "Check the recovery status before retrying.", 409);
  return handleError(error);
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("recovery_request_invalid");
    let raw: unknown;
    try { raw = await request.json(); } catch { throw new Error("recovery_request_invalid"); }
    const input = parseRequest(raw);
    const context = await requireGlobalSecurityContext();
    const throttleContext = { key: configuredGlobalSecurityThrottleKey(), client: canonicalizeTrustedClient(env.CUBBY_TRUSTED_PROXY_HOPS, request.headers.get("x-forwarded-for")) };
    if (input.action === "enroll" || input.action === "regenerate") {
      const authContext = await auth.$context;
      await issueFreshAuthGrantForCurrentPassword(prisma, context, { ...input.metadata, purpose: "recovery_enrollment" }, input.currentPassword, { verify: authContext.password.verify }, undefined, undefined, throttleContext);
      const issued = await issueRecoveryCodeSet(prisma, context, input.metadata);
      return ok({ operationId: issued.operationId, setVersion: issued.setVersion, codes: issued.codes, displayOnce: true });
    }
    if (input.action === "acknowledge") {
      const result = await acknowledgeRecoveryCodeSetSaved(prisma, context, input);
      return ok(result);
    }
    if (input.action === "rehearse") {
      const result = await rehearseRecoveryCodeSet(prisma, context, { ...input.metadata, setVersion: input.setVersion, code: input.code }, undefined, throttleContext);
      return ok(result);
    }
    const result = await getRecoveryEnrollmentStatus(prisma, context, input.metadata);
    return ok({ operationId: result.operationId, setVersion: result.setVersion, state: result.state, status: result.status, outcomeCode: result.outcomeCode, remainingCodes: result.remainingCodes, terminalAt: result.terminalAt });
  } catch (error) {
    return recoveryError(error);
  }
}
