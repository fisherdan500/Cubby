import { prisma } from "@/lib/db/prisma";
import { requireGlobalSecurityContext } from "@/server/auth/session";
import { fail, handleError, ok } from "@/server/http";
import { getPasswordChangeStatus } from "@/server/services/global-security";

export const dynamic = "force-dynamic";
const operationIdPattern = /^gso_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;

export async function POST(request: Request) {
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new Error("password_change_status_invalid");
    const input = await request.json() as Record<string, unknown>;
    if (!input || Object.keys(input).sort().join("|") !== "intentFingerprint|openingFingerprint|operationId" || typeof input.operationId !== "string" || !operationIdPattern.test(input.operationId) || typeof input.openingFingerprint !== "string" || !fingerprintPattern.test(input.openingFingerprint) || typeof input.intentFingerprint !== "string" || !fingerprintPattern.test(input.intentFingerprint)) throw new Error("password_change_status_invalid");
    const context = await requireGlobalSecurityContext();
    return ok(await getPasswordChangeStatus(prisma, context.userId, { operationId: input.operationId, openingFingerprint: input.openingFingerprint, intentFingerprint: input.intentFingerprint }));
  } catch (error) {
    if (error instanceof Error && error.message === "password_change_status_invalid") return fail(error.message, "Check the password change status request and try again.", 422);
    return handleError(error);
  }
}
