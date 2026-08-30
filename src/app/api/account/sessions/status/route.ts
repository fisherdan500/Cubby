import { prisma } from "@/lib/db/prisma";
import { requireGlobalSecurityContext } from "@/server/auth/session";
import { fail, handleError, ok } from "@/server/http";
import { getGlobalSessionRevokeStatus, recordQualifyingGlobalSessionUseAfterSuccess } from "@/server/services/global-session-security";

export const dynamic = "force-dynamic";

const operationIdPattern = /^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;

function parseStatusRequest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("session_revoke_status_request_invalid");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join("|") !== "intentFingerprint|openingFingerprint|operationId") throw new Error("session_revoke_status_request_invalid");
  if (typeof input.operationId !== "string" || !operationIdPattern.test(input.operationId) || typeof input.openingFingerprint !== "string" || !fingerprintPattern.test(input.openingFingerprint) || typeof input.intentFingerprint !== "string" || !fingerprintPattern.test(input.intentFingerprint)) throw new Error("session_revoke_status_request_invalid");
  return input as { operationId: string; openingFingerprint: string; intentFingerprint: string };
}

export async function POST(request: Request) {
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("session_revoke_status_request_invalid");
    let raw: unknown;
    try { raw = await request.json(); } catch { throw new Error("session_revoke_status_request_invalid"); }
    const input = parseStatusRequest(raw);
    const context = await requireGlobalSecurityContext();
    const result = await getGlobalSessionRevokeStatus(prisma, context, input);
    await recordQualifyingGlobalSessionUseAfterSuccess(prisma, context, "private_security_action");
    return ok(result);
  } catch (error) {
    if (error instanceof Error && error.message === "session_revoke_status_request_invalid") return fail(error.message, "Check the status request and try again.", 422);
    return handleError(error);
  }
}
